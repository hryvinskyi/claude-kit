import { z } from 'zod';
import type { BoardGateway, CatalogStore, Clock } from '../application/ports.ts';
import { boardNameOf, type BoardIdentity, type BoardOwnerType } from '../domain/board-directory.ts';
import type { BoardSnapshot, CatalogField, FieldCatalog, IssueFacts, ReadItemResult } from '../domain/catalog.ts';
import { IssueNotFound, TransientFailure } from '../domain/errors.ts';
import { IssueRef } from '../domain/issue-ref.ts';
import { RateBudget } from '../domain/rate-budget.ts';
import { decodeWire, type GitHubHttp, type GraphqlError } from './github-http.ts';

/** The board's root differs by the kind of account that owns it; the alias does not. */
const OWNER_ROOT: Record<BoardOwnerType, string> = {
  organization: 'organization',
  user: 'user',
};

const DEFAULT_SNAPSHOT_TTL_SEC = 60;
const ITEM_PAGE_SIZE = 100;

const FIELD_VALUES = `
  fieldValues(first: 20) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2FieldCommon { name } }
      }
    }
  }
`;

/** Everything a row of the board carries that writing to it and reading it back need. */
const ITEM_SELECTION = `
  id
  content { ... on Issue { number repository { nameWithOwner } } }
${FIELD_VALUES}`;

/**
 * A row as the board's work is read: the issue's own facts and the summaries of
 * what blocks it as well. The summaries are objects rather than connections, so
 * asking for them adds nothing to what a page costs; they are asked for only by
 * the walk that needs them, so nothing else depends on them being answered.
 */
const WORK_SELECTION = `
  id
  content {
    __typename
    ... on Issue {
      number
      title
      state
      createdAt
      updatedAt
      repository { nameWithOwner }
      issueDependenciesSummary { totalBlockedBy }
      subIssuesSummary { total }
    }
  }
${FIELD_VALUES}`;

const catalogQuery = (root: string): string => `
query BoardCatalog($owner: String!, $number: Int!) {
  owner: ${root}(login: $owner) {
    projectV2(number: $number) {
      id
      title
      fields(first: 30) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
    }
  }
}`;

const snapshotQuery = (root: string, operation: string, selection: string): string => `
query ${operation}($owner: String!, $number: Int!, $cursor: String) {
  rateLimit { cost }
  owner: ${root}(login: $owner) {
    projectV2(number: $number) {
      items(first: ${String(ITEM_PAGE_SIZE)}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {${selection}}
      }
    }
  }
}`;

const ISSUE_NODE_ID_QUERY = `
query IssueNodeId($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { id }
  }
}`;

const ADD_ITEM_MUTATION = `
mutation AddBoardItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`;

const READ_ITEM_QUERY = `
query BoardItem($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {${ITEM_SELECTION}}
  }
}`;

const SET_SINGLE_SELECT_MUTATION = `
mutation SetBoardSingleSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
  ) {
    projectV2Item { id }
  }
}`;

const BUDGET_QUERY = `
query BudgetProbe {
  rateLimit { remaining limit used resetAt cost }
}`;

const CatalogPayload = z.object({
  owner: z
    .object({
      projectV2: z
        .object({
          id: z.string(),
          title: z.string().nullable().optional(),
          fields: z
            .object({
              nodes: z
                .array(
                  z
                    .object({
                      id: z.string(),
                      name: z.string(),
                      dataType: z.string(),
                      options: z.array(z.object({ id: z.string(), name: z.string() })).nullable().optional(),
                    })
                    .nullable(),
                )
                .nullable()
                .optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable(),
    })
    .nullable(),
});

const ItemNode = z.object({
  id: z.string(),
  content: z.unknown().optional(),
  fieldValues: z
    .object({ nodes: z.array(z.unknown()).nullable().optional() })
    .nullable()
    .optional(),
});

const IssueContent = z.object({
  number: z.number().int().positive(),
  repository: z.object({ nameWithOwner: z.string() }),
  title: z.string().optional(),
  state: z.enum(['OPEN', 'CLOSED']).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  issueDependenciesSummary: z.object({ totalBlockedBy: z.number().int().nonnegative() }).nullable().optional(),
  subIssuesSummary: z.object({ total: z.number().int().nonnegative() }).nullable().optional(),
});

const ISSUE_STATE = { OPEN: 'open', CLOSED: 'closed' } as const satisfies Record<
  'OPEN' | 'CLOSED',
  IssueFacts['state']
>;

const SingleSelectValue = z.object({
  name: z.string(),
  field: z.object({ name: z.string() }),
});

const SnapshotPayload = z.object({
  rateLimit: z.object({ cost: z.number() }).nullable().optional(),
  owner: z
    .object({
      projectV2: z
        .object({
          items: z.object({
            pageInfo: z.object({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable().optional(),
            }),
            nodes: z.array(ItemNode.nullable()).nullable().optional(),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const IssueNodeIdPayload = z.object({
  repository: z
    .object({ issue: z.object({ id: z.string() }).nullable() })
    .nullable(),
});

const AddItemPayload = z.object({
  addProjectV2ItemById: z.object({ item: z.object({ id: z.string() }).nullable() }).nullable(),
});

const ReadItemPayload = z.object({ node: ItemNode.nullable() });

const SetSingleSelectPayload = z.object({
  updateProjectV2ItemFieldValue: z
    .object({ projectV2Item: z.object({ id: z.string() }).nullable() })
    .nullable(),
});

const BudgetPayload = z.object({
  rateLimit: z.object({
    remaining: z.number(),
    limit: z.number(),
    used: z.number(),
    resetAt: z.string(),
  }),
});

export type GitHubGraphqlBoardDeps = {
  http: GitHubHttp;
  board: BoardIdentity;
  clock: Clock;
  /** This board's own catalog slot: another board's fields and options carry other ids. */
  catalogStore: CatalogStore;
  catalogTtlSec: number;
  snapshotTtlSec?: number;
};

/**
 * The board, read and written through targeted graph calls.
 *
 * Membership is written, never inferred: asking an issue which board items it
 * belongs to was measured to answer an empty connection for issues that are
 * demonstrably on the board whenever the repository's owner differs from the
 * board's, which reads exactly like "not on the board" and would silently
 * re-add rows and fail every read-back. So adding is done unconditionally (the
 * mutation is idempotent and hands back the existing row), a known row is read
 * by its own id, and a reference is resolved against one paginated walk of the
 * whole board — a few points for every row at once, reused for a minute.
 */
export class GitHubGraphqlBoard implements BoardGateway {
  private readonly http: GitHubHttp;
  private readonly board: BoardIdentity;
  private readonly clock: Clock;
  private readonly catalogStore: CatalogStore;
  private readonly catalogTtlMs: number;
  private readonly snapshotTtlMs: number;
  private held: BoardSnapshot | null = null;

  constructor(deps: GitHubGraphqlBoardDeps) {
    this.http = deps.http;
    this.board = deps.board;
    this.clock = deps.clock;
    this.catalogStore = deps.catalogStore;
    this.catalogTtlMs = deps.catalogTtlSec * 1000;
    this.snapshotTtlMs = (deps.snapshotTtlSec ?? DEFAULT_SNAPSHOT_TTL_SEC) * 1000;
  }

  async catalog(force = false): Promise<FieldCatalog> {
    if (!force) {
      const cached = await this.catalogStore.get();
      if (cached !== null && this.age(cached.fetchedAt) < this.catalogTtlMs) {
        return cached.catalog;
      }
    }
    const subject = 'the board catalog';
    const payload = decodeWire(
      CatalogPayload,
      await this.http.graphql(
        catalogQuery(OWNER_ROOT[this.board.ownerType]),
        { owner: this.board.owner, number: this.board.number },
        subject,
      ),
      subject,
    );
    const project = payload.owner?.projectV2 ?? null;
    if (project === null) {
      throw new TransientFailure(`${subject} answered no project for ${this.boardName()}`);
    }
    const fields: CatalogField[] = [];
    for (const node of project.fields?.nodes ?? []) {
      if (node === null) {
        continue;
      }
      fields.push({
        id: node.id,
        name: node.name,
        dataType: node.dataType,
        options: (node.options ?? []).map((option) => ({ id: option.id, name: option.name })),
      });
    }
    const catalog: FieldCatalog = { projectId: project.id, fields };
    await this.catalogStore.put(catalog, this.clock.now());
    return catalog;
  }

  async snapshot(force = false): Promise<BoardSnapshot> {
    if (!force && this.held !== null && this.age(this.held.fetchedAt) < this.snapshotTtlMs) {
      return this.held;
    }
    const snapshot = await this.walk('BoardSnapshot', ITEM_SELECTION, 'the board listing');
    this.held = snapshot;
    return snapshot;
  }

  /** Every row with its issue's facts, walked afresh each time: it is read once per import. */
  async readWork(): Promise<BoardSnapshot> {
    return this.walk('BoardWork', WORK_SELECTION, 'the board\'s work');
  }

  private async walk(operation: string, selection: string, subject: string): Promise<BoardSnapshot> {
    const query = snapshotQuery(OWNER_ROOT[this.board.ownerType], operation, selection);
    const items: ReadItemResult[] = [];
    let unreadable = 0;
    let cost: number | null = null;
    let cursor: string | null = null;
    for (;;) {
      const payload: z.infer<typeof SnapshotPayload> = decodeWire(
        SnapshotPayload,
        await this.http.graphql(
          query,
          { owner: this.board.owner, number: this.board.number, cursor },
          subject,
          { tolerates: isUnreadableRow },
        ),
        subject,
      );
      const project = payload.owner?.projectV2 ?? null;
      if (project === null) {
        throw new TransientFailure(`${subject} answered no project for ${this.boardName()}`);
      }
      const pageCost = payload.rateLimit?.cost ?? null;
      if (pageCost !== null) {
        cost = (cost ?? 0) + pageCost;
      }
      for (const node of project.items.nodes ?? []) {
        if (node === null || node.content === null || node.content === undefined) {
          unreadable += 1;
          continue;
        }
        const item = toReadItem(node);
        if (item !== null) {
          items.push(item);
        }
      }
      if (!project.items.pageInfo.hasNextPage) {
        break;
      }
      const next = project.items.pageInfo.endCursor ?? null;
      if (next === null) {
        // A page that claims a successor but names no cursor would loop forever.
        throw new TransientFailure(`${subject} promised another page without saying where it starts`);
      }
      cursor = next;
    }
    return { fetchedAt: this.clock.now(), items, unreadable, cost };
  }

  /**
   * Forgets the listing this process is holding.
   *
   * The listing is what every membership question is answered from, and it is
   * kept for a minute so that asking about several issues costs what asking about
   * the first one cost. A write in the same run makes it wrong, and a
   * verification filed behind that write would then read the board as it was
   * before it — and report a mismatch against a value this system had just set.
   */
  private forgetListing(): void {
    this.held = null;
  }

  async findItem(ref: IssueRef): Promise<ReadItemResult | null> {
    return matchIn(await this.snapshot(), ref);
  }

  async membership(refs: readonly IssueRef[]): Promise<Map<string, ReadItemResult | 'missing'>> {
    const snapshot = await this.snapshot();
    const found = new Map<string, ReadItemResult | 'missing'>();
    for (const ref of refs) {
      found.set(ref.key(), matchIn(snapshot, ref) ?? 'missing');
    }
    return found;
  }

  /** The issue's own node id, which is what the board's add mutation takes. */
  async issueNodeId(ref: IssueRef): Promise<string> {
    const subject = ref.toString();
    const payload = decodeWire(
      IssueNodeIdPayload,
      await this.http.graphql(
        ISSUE_NODE_ID_QUERY,
        { owner: ref.owner, repo: ref.repo, number: ref.number },
        subject,
        // This call names one issue and nothing else, so an answer of "not found"
        // is about that issue: a dead end a person has to look at.
        { scope: 'issue' },
      ),
      subject,
    );
    const id = payload.repository?.issue?.id ?? null;
    if (id === null) {
      throw new IssueNotFound(subject);
    }
    return id;
  }

  async ensureItem(ref: IssueRef): Promise<string> {
    const contentId = await this.issueNodeId(ref);
    const projectId = (await this.catalog()).projectId;
    const subject = `adding ${ref.toString()} to the board`;
    const payload = decodeWire(
      AddItemPayload,
      await this.http.graphql(ADD_ITEM_MUTATION, { projectId, contentId }, subject),
      subject,
    );
    const itemId = payload.addProjectV2ItemById?.item?.id ?? null;
    if (itemId === null) {
      throw new TransientFailure(`${subject} answered no row`);
    }
    this.forgetListing();
    return itemId;
  }

  async readItemById(itemId: string): Promise<ReadItemResult> {
    const subject = `the board row ${itemId}`;
    const payload = decodeWire(
      ReadItemPayload,
      await this.http.graphql(READ_ITEM_QUERY, { itemId }, subject),
      subject,
    );
    const node = payload.node;
    const item = node === null ? null : toReadItem(node);
    if (item === null) {
      throw new TransientFailure(`${subject} answered nothing that holds an issue`);
    }
    return item;
  }

  async setSingleSelect(itemId: string, fieldId: string, optionId: string): Promise<void> {
    const projectId = (await this.catalog()).projectId;
    const subject = `writing a value on the board row ${itemId}`;
    const payload = decodeWire(
      SetSingleSelectPayload,
      await this.http.graphql(
        SET_SINGLE_SELECT_MUTATION,
        { projectId, itemId, fieldId, optionId },
        subject,
      ),
      subject,
    );
    if ((payload.updateProjectV2ItemFieldValue?.projectV2Item?.id ?? null) === null) {
      throw new TransientFailure(`${subject} answered no row`);
    }
    await this.noteWritten(itemId, fieldId, optionId);
  }

  /**
   * Keeps the listing true after a value was written, rather than dropping it: a
   * value written changes no row's membership, and a listing walked again after
   * every write would cost a whole walk per write. A field or option the catalog
   * cannot name drops the listing instead, so nothing is read from it that is not
   * so.
   */
  private async noteWritten(itemId: string, fieldId: string, optionId: string): Promise<void> {
    const held = this.held;
    if (held === null) {
      return;
    }
    const field = (await this.catalog()).fields.find((one) => one.id === fieldId);
    const option = field?.options.find((one) => one.id === optionId);
    if (field === undefined || option === undefined) {
      this.forgetListing();
      return;
    }
    this.held = {
      ...held,
      items: held.items.map((item) => (item.itemId === itemId
        ? { ...item, values: { ...item.values, [field.name]: option.name } }
        : item)),
    };
  }

  async probeBudget(): Promise<RateBudget> {
    const subject = 'the allowance probe';
    const payload = decodeWire(
      BudgetPayload,
      await this.http.graphql(BUDGET_QUERY, {}, subject),
      subject,
    );
    const resetAt = new Date(payload.rateLimit.resetAt);
    if (Number.isNaN(resetAt.getTime())) {
      throw new TransientFailure(`${subject} answered a reset time that is not a date`);
    }
    const budget = new RateBudget({
      resource: 'graphql',
      remaining: payload.rateLimit.remaining,
      limit: payload.rateLimit.limit,
      used: payload.rateLimit.used,
      resetAt,
    });
    this.http.rememberBudget(budget);
    return budget;
  }

  lastBudget(): RateBudget | null {
    return this.http.lastBudget('graphql');
  }

  private boardName(): string {
    return boardNameOf(this.board);
  }

  private age(moment: Date): number {
    return this.clock.now().getTime() - moment.getTime();
  }
}

/**
 * One row of a listing whose content the board would not answer for.
 *
 * It answers such a page with everything it could read plus one error naming the
 * row it could not, and that row comes back empty. The rest of the page is as
 * good as any other answer, so it is kept and the row is passed over; refusing
 * the whole listing would stop every action on the board over one item nobody
 * here can reach. Only where the error points decides this, not what it says:
 * whatever went wrong at that path, the row is unusable and the page is not.
 */
function isUnreadableRow(error: GraphqlError): boolean {
  const path = error.path ?? [];
  const at = path.indexOf('items');
  return at >= 0
    && path[at + 1] === 'nodes'
    && typeof path[at + 2] === 'number'
    && path[at + 3] === 'content';
}

/** The board carries several repositories whose numbers collide; both must agree. */
function matchIn(snapshot: BoardSnapshot, ref: IssueRef): ReadItemResult | null {
  return snapshot.items.find((item) => item.ref.equals(ref)) ?? null;
}

/** A row whose content is not an issue (a draft, a pull request) is not ours. */
function toReadItem(node: z.infer<typeof ItemNode>): ReadItemResult | null {
  const content = IssueContent.safeParse(node.content);
  if (!content.success) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const raw of node.fieldValues?.nodes ?? []) {
    const value = SingleSelectValue.safeParse(raw);
    if (value.success) {
      values[value.data.field.name] = value.data.name;
    }
  }
  const item: ReadItemResult = {
    itemId: node.id,
    ref: IssueRef.of(content.data.repository.nameWithOwner, content.data.number),
    values,
  };
  const facts = factsOf(content.data);
  if (facts !== null) {
    item.issue = facts;
  }
  return item;
}

/** The issue's own facts, when the row answered every one of them. */
function factsOf(content: z.infer<typeof IssueContent>): IssueFacts | null {
  const { title, state, createdAt, updatedAt } = content;
  if (title === undefined || state === undefined || createdAt === undefined || updatedAt === undefined) {
    return null;
  }
  return {
    title,
    state: ISSUE_STATE[state],
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    blockedByTotal: content.issueDependenciesSummary?.totalBlockedBy ?? null,
    subIssuesTotal: content.subIssuesSummary?.total ?? null,
  };
}
