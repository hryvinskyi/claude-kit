"""review_report.py — render a review's pull request section and TODO rows from its result files.

Usage:
    python3 review_report.py --result FILE --outcomes FILE [--delta FILE]... [--todo-date YYYY-MM-DD]

--result is the review workflow's result for the wave; each --delta is the result of a delta pass, in
the order the passes ran (a fix that the suite forces gets a second one). --outcomes is a JSON object of
finding id to what became of it:

    { "<id>": { "outcome": "fixed" | "answered" | "moved",
                "commit": "<sha>",        # fixed
                "answer": "<text>",       # answered
                "ticket": "<ref>" } }     # moved

An id without an outcome renders as open, so `{}` is a valid file: a review that fixed nothing.

Standard output is Markdown: a "## Review" section (the members, a table of the findings, the refuted
findings, the candidates each member checked and cleared and the readers it checked, those that were not
verified, the members whose findings were discarded, what was not checked) and, only when a finding was
moved to a ticket, a "## TODO rows" section with one line per moved finding. The date on those lines
comes from --todo-date, since the script keeps no clock of its own and so prints the same text for the
same files. A member's `cleared` and `readers_checked` lists may be absent, which reads as empty.

The output is pasted into a pull request as it is, so no text reaches it raw. Every value of a
secret-looking line is withheld with the filter decide.py beside this script applies before it sends
anything, and the number of lines that lost a value is printed under "Not checked" (a text printed
twice counts once). Outside a code span, an `@` before a letter or digit is followed by a zero-width
joiner, so a word such as `@throws` never mentions an account; a backtick that opens no code span within
its own text becomes an apostrophe, so it cannot pair with a code span printed after it.

Nothing is printed unless every file is valid. Exit status: 0 rendered; 2 the input is unusable — a file
that is missing, over the size bound or not JSON, a field the output needs that is absent or of the
wrong type, an outcome that is unknown or lacks its detail, an outcome for an id no result holds, one id
held by two results, or a row to print without --todo-date.
"""
from __future__ import annotations

import argparse
import datetime
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

MAX_BYTES = 8 * 1024 * 1024
NO_LOCATION = "—"
# Written after an `@` that would otherwise start a mention; invisible, and not a name character.
MENTION_BREAK = "‍"
MENTION = re.compile(r"@(?=[A-Za-z0-9])")
BACKTICKS = re.compile(r"`+")

Json = Dict[str, Any]
# A text with the values of its secret-looking lines withheld, and how many lines lost one.
Withhold = Callable[[str], Tuple[str, int]]


class ReportError(Exception):
    """The input cannot be rendered; the message says which file or id and what is wrong."""


# --- reading -------------------------------------------------------------------------------------


def read_json(path: str, label: str) -> Any:
    """The JSON document at path, read within the size bound."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
    except OSError as error:
        raise ReportError("%s: cannot read %s: %s" % (label, path, error.strerror or error))
    if len(raw) > MAX_BYTES:
        raise ReportError("%s: %s is larger than %d bytes" % (label, path, MAX_BYTES))
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ReportError("%s: %s is not valid JSON: %s" % (label, path, error))


def is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def need_object(value: object, where: str) -> Json:
    if not isinstance(value, dict):
        raise ReportError("%s must be an object" % where)
    return value


def need_text(obj: Json, key: str, where: str, nullable: bool = False) -> Optional[str]:
    value = obj.get(key)
    if isinstance(value, str):
        return value
    if nullable and value is None and key in obj:
        return None
    raise ReportError("%s: field '%s' must be %s" % (where, key, "a string or null" if nullable else "a string"))


def need_int(obj: Json, key: str, where: str, nullable: bool = False) -> Optional[int]:
    value = obj.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if nullable and value is None and key in obj:
        return None
    raise ReportError("%s: field '%s' must be %s" % (where, key, "an integer or null" if nullable else "an integer"))


def need_list(obj: Json, key: str, where: str, optional: bool = False) -> List[Any]:
    if optional and key not in obj:
        return []
    value = obj.get(key)
    if isinstance(value, list):
        return value
    raise ReportError("%s: field '%s' must be a list" % (where, key))


def need_objects(obj: Json, key: str, where: str, optional: bool = False) -> List[Json]:
    return [need_object(item, "%s.%s[%d]" % (where, key, index))
            for index, item in enumerate(need_list(obj, key, where, optional))]


def check_member(member: Json, where: str) -> None:
    """The fields a member line needs, and the checks it cleared when it lists any."""
    need_text(member, "name", where)
    need_text(member, "model", where, nullable=True)
    need_text(member, "effort", where, nullable=True)
    need_text(member, "status", where)
    need_int(member, "findings", where)
    for index, entry in enumerate(need_objects(member, "cleared", where, optional=True)):
        need_text(entry, "candidate", "%s.cleared[%d]" % (where, index))
        need_text(entry, "refuting_line", "%s.cleared[%d]" % (where, index))
    for index, entry in enumerate(need_objects(member, "readers_checked", where, optional=True)):
        need_text(entry, "symbol", "%s.readers_checked[%d]" % (where, index))
        need_int(entry, "hits", "%s.readers_checked[%d]" % (where, index))
        need_text(entry, "verdict", "%s.readers_checked[%d]" % (where, index))


def check_finding(finding: Json, where: str, verified: bool) -> None:
    """The fields every rendered finding needs; a verified one also carries a verdict and its finders."""
    need_text(finding, "id", where)
    need_text(finding, "defect", where)
    need_text(finding, "file", where, nullable=True)
    if finding.get("file") is not None:
        need_int(finding, "line", where, nullable=True)
    if verified:
        need_text(finding, "verdict", where)
        for index, name in enumerate(need_list(finding, "found_by", where)):
            if not isinstance(name, str):
                raise ReportError("%s: found_by[%d] must be a string" % (where, index))
        for index, duplicate in enumerate(need_objects(finding, "duplicates", where, optional=True)):
            need_text(duplicate, "member", "%s.duplicates[%d]" % (where, index))


def parse_result(data: object, label: str, mode: str) -> Json:
    """A workflow result, checked for everything the report prints."""
    result = need_object(data, label)
    if need_text(result, "mode", label) != mode:
        raise ReportError("%s: mode must be '%s'" % (label, mode))
    if mode == "delta":
        need_int(result, "round", label)
    need_text(result, "class", label)
    for index, member in enumerate(need_objects(result, "members", label)):
        check_member(member, "%s.members[%d]" % (label, index))
    for index, finding in enumerate(need_objects(result, "findings", label)):
        check_finding(finding, "%s.findings[%d]" % (label, index), True)
    for index, finding in enumerate(need_objects(result, "refuted", label)):
        check_finding(finding, "%s.refuted[%d]" % (label, index), False)
        need_text(finding, "evidence", "%s.refuted[%d]" % (label, index))
    for index, finding in enumerate(need_objects(result, "unverified", label)):
        check_finding(finding, "%s.unverified[%d]" % (label, index), False)
        need_text(finding, "reason", "%s.unverified[%d]" % (label, index))
    for index, entry in enumerate(need_objects(result, "discarded", label)):
        where = "%s.discarded[%d]" % (label, index)
        need_text(entry, "member", where)
        need_text(entry, "reason", where)
        if not (is_int(entry.get("findings")) or isinstance(entry.get("findings"), list)):
            raise ReportError("%s: field 'findings' must be a count or a list" % where)
    for index, line in enumerate(need_list(result, "not_checked", label)):
        if not isinstance(line, str):
            raise ReportError("%s.not_checked[%d] must be a string" % (label, index))
    return result


def finding_ids(result: Json) -> List[Tuple[str, Json]]:
    """Every finding a result holds, an attached duplicate after the finding it hangs on."""
    held: List[Tuple[str, Json]] = []
    for finding in result["findings"]:
        held.append((finding["id"], finding))
        for duplicate in finding.get("duplicates") or []:
            if isinstance(duplicate.get("id"), str):
                held.append((duplicate["id"], duplicate))
    for section in ("refuted", "unverified"):
        for finding in result[section]:
            held.append((finding["id"], finding))
    return held


# --- outcomes ------------------------------------------------------------------------------------

# The detail an outcome of each kind must carry; a kind that is not a key here is not an outcome.
OUTCOME_DETAIL = {"fixed": "commit", "answered": "answer", "moved": "ticket"}


def parse_outcomes(data: object, known: Dict[str, Json]) -> Dict[str, Json]:
    """The outcomes file, checked against the ids the results hold; every problem is named."""
    outcomes = need_object(data, "outcomes")
    problems: List[str] = []
    for ident, entry in outcomes.items():
        if ident not in known:
            problems.append("%s: no result holds this id" % ident)
            continue
        if not isinstance(entry, dict):
            problems.append("%s: the outcome must be an object" % ident)
            continue
        kind = entry.get("outcome")
        if not isinstance(kind, str) or kind not in OUTCOME_DETAIL:
            problems.append("%s: unknown outcome %s (use fixed, answered or moved)" % (ident, json.dumps(kind)))
            continue
        detail = entry.get(OUTCOME_DETAIL[kind])
        if not isinstance(detail, str) or not detail.strip():
            problems.append("%s: outcome '%s' needs a '%s'" % (ident, kind, OUTCOME_DETAIL[kind]))
    if problems:
        raise ReportError("outcomes: " + "; ".join(problems))
    return dict(outcomes)


# --- text ----------------------------------------------------------------------------------------


def flat(text: str) -> str:
    """One line: every run of whitespace, line breaks included, becomes one space."""
    return " ".join(text.split())


def pipe_safe(text: str) -> str:
    """Text that stays in its table cell: a bare pipe is escaped."""
    return text.replace("|", "\\|")


def break_mentions(text: str) -> str:
    """text with MENTION_BREAK after every `@` that precedes a letter or digit outside a code span. A
    backtick run that no later run of the same length closes opens no code span, and becomes as many
    apostrophes, so it cannot pair with a code span printed after this text."""
    runs = list(BACKTICKS.finditer(text))
    out: List[str] = []
    start = 0
    index = 0
    while index < len(runs):
        opener = runs[index]
        out.append(MENTION.sub("@" + MENTION_BREAK, text[start:opener.start()]))
        closer = next((later for later in range(index + 1, len(runs))
                       if len(runs[later].group()) == len(opener.group())), None)
        if closer is None:
            out.append("'" * len(opener.group()))
            start = opener.end()
            index += 1
        else:
            start = runs[closer].end()
            out.append(text[opener.start():start])
            index = closer + 1
    out.append(MENTION.sub("@" + MENTION_BREAK, text[start:]))
    return "".join(out)


class Printable:
    """The results' text as it may be pasted into a pull request: on one line, with the values of
    secret-looking lines withheld and, outside a code span, no mention. `masked` counts the lines that
    lost a value; a text printed more than once counts once."""

    def __init__(self, withhold: Withhold) -> None:
        self._withhold = withhold
        self._kept: Dict[str, str] = {}
        self.masked = 0

    def plain(self, text: str) -> str:
        """The text withheld where it looks like a secret, on one line; mentions untouched."""
        if text not in self._kept:
            kept, lines = self._withhold(text)
            self._kept[text] = flat(kept)
            self.masked += lines
        return self._kept[text]

    def prose(self, text: str) -> str:
        """The text as running Markdown: withheld, on one line, no mention outside its code spans."""
        return break_mentions(self.plain(text))

    def cell(self, text: str) -> str:
        """The text as a table cell: prose with no bare pipe."""
        return pipe_safe(self.prose(text))

    def code(self, text: str) -> str:
        """The text quoted as code; a backtick inside it becomes an apostrophe, so the quote cannot end early."""
        return "`" + self.plain(text).replace("`", "'") + "`"


def location(finding: Json, printable: Printable) -> str:
    file = finding.get("file")
    if not isinstance(file, str):
        return NO_LOCATION
    line = finding.get("line")
    # A code span keeps the path as written, so it can be copied, and mentions nobody.
    return printable.code("%s:%d" % (file, line) if is_int(line) else file)


def count_label(count: int, noun: str = "finding") -> str:
    return "%d %s%s" % (count, noun, "" if count == 1 else "s")


# What each outcome reads as in the findings table; "open" is the id with no outcome.
OUTCOME_CELLS: Dict[str, Callable[[Json, Printable], str]] = {
    "fixed": lambda entry, printable: "fixed %s" % printable.prose(entry["commit"]),
    "answered": lambda entry, printable: "answered: %s" % printable.prose(entry["answer"]),
    "moved": lambda entry, printable: "moved to %s" % printable.prose(entry["ticket"]),
    "open": lambda entry, printable: "open",
}


def outcome_text(ident: str, outcomes: Dict[str, Json], printable: Printable) -> str:
    entry = outcomes.get(ident, {"outcome": "open"})
    return OUTCOME_CELLS[entry["outcome"]](entry, printable)


def found_by(finding: Json, printable: Printable) -> str:
    names = ", ".join(printable.prose(name) for name in finding["found_by"])
    extra = "".join(" (+%s)" % printable.prose(duplicate["member"]) for duplicate in finding.get("duplicates") or [])
    return names + extra


# --- rendering -----------------------------------------------------------------------------------


def member_lines(result: Json, printable: Printable) -> List[str]:
    return ["- %s · %s · %s — %s, %s" % (
        printable.prose(member["name"]), printable.prose(member["model"] or NO_LOCATION),
        printable.prose(member["effort"] or NO_LOCATION), printable.prose(member["status"]),
        count_label(member["findings"])) for member in result["members"]]


def findings_table(results: Sequence[Json], outcomes: Dict[str, Json], printable: Printable) -> List[str]:
    rows: List[str] = []
    for result in results:
        for finding in result["findings"]:
            rows.append("| %d | %s | %s | %s | %s | %s |" % (
                len(rows) + 1, pipe_safe(location(finding, printable)), printable.cell(finding["defect"]),
                pipe_safe(found_by(finding, printable)), printable.cell(finding["verdict"].replace("_", " ")),
                pipe_safe(outcome_text(finding["id"], outcomes, printable))))
    header = ["| # | file:line | defect | found by | verdict | outcome |", "| --- | --- | --- | --- | --- | --- |"]
    return header + rows if rows else []


def quoted_tail(text: str, printable: Printable) -> str:
    """` — ` and text quoted as code, or nothing when text is blank."""
    return " — " + printable.code(text) if text.strip() else ""


def refuted_lines(results: Sequence[Json], printable: Printable) -> List[str]:
    return ["- %s — %s%s" % (location(finding, printable), printable.prose(finding["defect"]),
                             quoted_tail(finding["evidence"], printable))
            for result in results for finding in result["refuted"]]


def cleared_lines(results: Sequence[Json], printable: Printable) -> List[str]:
    return ["- %s: %s%s" % (printable.prose(member["name"]), printable.prose(entry["candidate"]),
                            quoted_tail(entry["refuting_line"], printable))
            for result in results for member in result["members"] for entry in member.get("cleared") or []]


def reader_lines(results: Sequence[Json], printable: Printable) -> List[str]:
    return ["- %s: %s — %s — %s" % (printable.prose(member["name"]), printable.code(entry["symbol"]),
                                    count_label(entry["hits"], "hit"), printable.prose(entry["verdict"]))
            for result in results for member in result["members"] for entry in member.get("readers_checked") or []]


def unverified_lines(results: Sequence[Json], outcomes: Dict[str, Json], printable: Printable) -> List[str]:
    return ["- %s — %s — %s; %s" % (
        location(finding, printable), printable.prose(finding["defect"]), printable.prose(finding["reason"]),
        outcome_text(finding["id"], outcomes, printable))
        for result in results for finding in result["unverified"]]


def discarded_lines(results: Sequence[Json], printable: Printable) -> List[str]:
    lines = []
    for result in results:
        for entry in result["discarded"]:
            held = entry["findings"]
            total = len(held) if isinstance(held, list) else held
            lines.append("- %s — %s (%s)" % (printable.prose(entry["member"]), printable.prose(entry["reason"]),
                                             count_label(total)))
    return lines


def review_section(results: Sequence[Json], outcomes: Dict[str, Json], printable: Printable) -> List[str]:
    """The review section; its "Not checked" list ends with the count of every value `printable` withheld
    up to that point, so text printed after this section must go through `printable` before it."""
    wave, deltas = results[0], results[1:]
    out = ["## Review", "", "/pipeline:review, class %s." % printable.prose(wave["class"]), "", "**Members**", ""]
    out += member_lines(wave, printable)
    for delta in deltas:
        out += ["", "**Delta pass %s**" % delta["round"], ""] + member_lines(delta, printable)
    out += ["", "**Findings**", ""] + (findings_table(results, outcomes, printable) or ["None."])
    out += ["", "**Refuted**", ""] + (refuted_lines(results, printable) or ["None."])
    for title, lines in (("Checked and cleared", cleared_lines(results, printable)),
                         ("Readers checked", reader_lines(results, printable)),
                         ("Not verified", unverified_lines(results, outcomes, printable)),
                         ("Discarded", discarded_lines(results, printable))):
        if lines:
            out += ["", "**%s**" % title, ""] + lines
    not_checked = ["- " + printable.prose(line) for result in results for line in result["not_checked"]]
    if printable.masked:
        not_checked.append("- %s with a secret-looking value withheld" % count_label(printable.masked, "line"))
    if not_checked:
        out += ["", "**Not checked**", ""] + not_checked
    return out


def todo_section(order: Sequence[Tuple[str, Json]], outcomes: Dict[str, Json], date: str, printable: Printable) -> List[str]:
    rows = []
    for ident, finding in order:
        entry = outcomes.get(ident)
        if entry is None or entry["outcome"] != "moved":
            continue
        scenario = finding.get("failure_scenario")
        tail = "; " + printable.prose(scenario) if isinstance(scenario, str) and scenario.strip() else ""
        rows.append("- [ ] **%s — %s** (%s) — %s%s" % (
            printable.prose(entry["ticket"]), printable.prose(finding["defect"]), date, location(finding, printable), tail))
    return ["", "## TODO rows", ""] + rows


def parse_date(text: str) -> str:
    """text when it is a real date written YYYY-MM-DD, nothing looser."""
    try:
        valid = datetime.datetime.strptime(text, "%Y-%m-%d").strftime("%Y-%m-%d") == text
    except ValueError:
        valid = False
    if not valid:
        raise ReportError("--todo-date must be a date as YYYY-MM-DD, not %s" % json.dumps(text))
    return text


def render(result_path: str, outcomes_path: str, delta_paths: Sequence[str], todo_date: Optional[str],
           withhold: Withhold) -> str:
    date = parse_date(todo_date) if todo_date is not None else None
    paths = [result_path] + list(delta_paths)
    results = [parse_result(read_json(result_path, "--result"), "--result", "wave")]
    for path in delta_paths:
        results.append(parse_result(read_json(path, "--delta"), "--delta %s" % path, "delta"))
    known: Dict[str, Json] = {}
    order: List[Tuple[str, Json]] = []
    for path, result in zip(paths, results):
        for ident, finding in finding_ids(result):
            if ident in known:
                raise ReportError("id %s is held by more than one result (again in %s)" % (ident, path))
            known[ident] = finding
            order.append((ident, finding))
    outcomes = parse_outcomes(read_json(outcomes_path, "--outcomes"), known)
    printable = Printable(withhold)
    todo: List[str] = []
    if any(entry["outcome"] == "moved" for entry in outcomes.values()):
        if date is None:
            raise ReportError("--todo-date is required: a finding was moved to a ticket, and its TODO row carries the date")
        todo = todo_section(order, outcomes, date, printable)
    return "\n".join(review_section(results, outcomes, printable) + todo) + "\n"


def load_withhold() -> Withhold:
    """decide.py's filter, loaded from this script's own directory, so the report withholds what a
    decision request withholds and the two never drift apart."""
    path = Path(__file__).resolve().parent / "decide.py"
    spec = importlib.util.spec_from_file_location("pipeline_decide_filter", str(path))
    if spec is None or spec.loader is None:
        raise ReportError("cannot load the secret filter from %s" % path)
    module = importlib.util.module_from_spec(spec)
    # A dataclass resolves its own module through sys.modules while the module is being executed.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        withhold = module.withhold
    except (OSError, ImportError, SyntaxError, AttributeError) as error:
        raise ReportError("cannot load the secret filter from %s: %s" % (path, error)) from error
    if not callable(withhold):
        raise ReportError("cannot load the secret filter from %s: withhold is not a function" % path)
    loaded: Withhold = withhold
    return loaded


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(prog="review_report.py", description="Render a review's report section and TODO rows.")
    parser.add_argument("--result", required=True, help="the wave's workflow result (JSON)")
    parser.add_argument("--outcomes", required=True, help="finding id to outcome (JSON); {} when nothing was fixed")
    parser.add_argument("--delta", action="append", default=[], help="a delta pass's result; repeat per pass, in order")
    parser.add_argument("--todo-date", help="YYYY-MM-DD, required when a finding was moved to a ticket")
    args = parser.parse_args(list(argv))
    try:
        withhold = load_withhold()
        text = render(args.result, args.outcomes, args.delta, args.todo_date, withhold)
    except ReportError as error:
        sys.stderr.write("review_report: %s\n" % error)
        return 2
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
