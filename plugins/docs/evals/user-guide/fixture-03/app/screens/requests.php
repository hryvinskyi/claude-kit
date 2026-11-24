<?php
/**
 * Inbox > Requests.
 *
 * @var \Acme\Desk\Viewer $viewer
 * @var string $show 'open' or 'archived'
 * @var list<array{id: int, subject: string, customer: string, answered: bool}> $requests
 * @var callable(string): string $t
 */
?>
<h1><?= $t('requests.title') ?></h1>

<form method="get" action="/inbox/requests">
    <label><?= $t('requests.show') ?>
        <select name="show">
            <option value="open" <?= $show === 'open' ? 'selected' : '' ?>><?= $t('requests.show.open') ?></option>
            <option value="archived" <?= $show === 'archived' ? 'selected' : '' ?>><?= $t('requests.show.archived') ?></option>
        </select>
    </label>
</form>

<?php if ($show === 'archived'): ?>
<p><?= $t('requests.archive_note') ?></p>
<?php if ($viewer->can('requests.export')): ?>
<form method="post" action="/inbox/requests/export"><button><?= $t('requests.export') ?></button></form>
<?php endif ?>
<?php endif ?>

<form method="post" action="/inbox/requests/archive">
<table>
    <tbody>
    <?php foreach ($requests as $request): ?>
        <tr>
            <?php if ($show === 'open' && $viewer->can('requests.archive')): ?>
            <td><input type="checkbox" name="ids[]" value="<?= $request['id'] ?>"></td>
            <?php endif ?>
            <td><a href="/inbox/requests/<?= $request['id'] ?>"><?= htmlspecialchars($request['subject']) ?></a></td>
            <td><?= htmlspecialchars($request['customer']) ?></td>
            <?php if ($show === 'archived'): ?>
            <td>
                <?php if ($viewer->can('requests.unarchive')): ?><button name="unarchive" value="<?= $request['id'] ?>"><?= $t('requests.unarchive') ?></button><?php endif ?>
                <?php if ($viewer->can('requests.purge')): ?><button name="purge" value="<?= $request['id'] ?>"><?= $t('requests.purge') ?></button><?php endif ?>
            </td>
            <?php endif ?>
        </tr>
    <?php endforeach ?>
    </tbody>
</table>
<?php if ($show === 'open' && $viewer->can('requests.archive')): ?>
<button><?= $t('requests.archive') ?></button>
<?php endif ?>
</form>
