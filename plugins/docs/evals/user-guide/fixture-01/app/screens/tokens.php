<?php
/**
 * Account > Access tokens.
 *
 * @var \Acme\Desk\Viewer $viewer
 * @var list<array{name: string, created: string, expires: string}> $tokens
 * @var callable(string): string $t
 */
?>
<h1><?= $t('tokens.title') ?></h1>

<?php if ($viewer->can('tokens.create')): ?>
<form method="post" action="/account/tokens">
    <label><?= $t('tokens.name') ?> <input name="name" required></label>
    <label><?= $t('tokens.expiry') ?>
        <select name="expiry">
            <option value="30"><?= $t('tokens.expiry.30') ?></option>
            <option value="90" selected><?= $t('tokens.expiry.90') ?></option>
            <option value="0"><?= $t('tokens.expiry.never') ?></option>
        </select>
    </label>
    <button><?= $t('tokens.create') ?></button>
</form>
<?php endif ?>

<table>
    <thead><tr><th><?= $t('tokens.name') ?></th><th><?= $t('tokens.created') ?></th><th><?= $t('tokens.expires') ?></th><th></th></tr></thead>
    <tbody>
    <?php foreach ($tokens as $token): ?>
        <tr>
            <td><?= htmlspecialchars($token['name']) ?></td>
            <td><?= htmlspecialchars($token['created']) ?></td>
            <td><?= htmlspecialchars($token['expires']) ?></td>
            <td><?php if ($viewer->can('tokens.revoke')): ?><button name="revoke"><?= $t('tokens.revoke') ?></button><?php endif ?></td>
        </tr>
    <?php endforeach ?>
    </tbody>
</table>

<?php if ($tokens === [] && !$viewer->can('tokens.create')): ?>
<p><?= $t('tokens.none') ?></p>
<?php endif ?>
