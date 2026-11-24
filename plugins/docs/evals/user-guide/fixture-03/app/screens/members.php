<?php
/**
 * Team > Members.
 *
 * @var \Acme\Desk\Viewer $viewer
 * @var list<array{name: string, email: string, role: string}> $members
 * @var list<array{email: string, sent: string}> $invitations
 * @var callable(string): string $t
 */
?>
<h1><?= $t('members.title') ?></h1>

<?php if ($viewer->can('members.invite')): ?>
<form method="post" action="/team/members/invite">
    <label><?= $t('members.email') ?> <input type="email" name="email" required></label>
    <label><?= $t('members.role') ?>
        <select name="role">
            <option value="agent" selected><?= $t('role.agent') ?></option>
            <option value="team_admin"><?= $t('role.team_admin') ?></option>
        </select>
    </label>
    <button><?= $t('members.invite') ?></button>
</form>
<?php endif ?>

<table>
    <thead><tr><th><?= $t('members.name') ?></th><th><?= $t('members.email') ?></th><th><?= $t('members.role') ?></th><th></th></tr></thead>
    <tbody>
    <?php foreach ($members as $member): ?>
        <tr>
            <td><?= htmlspecialchars($member['name']) ?></td>
            <td><?= htmlspecialchars($member['email']) ?></td>
            <td><?= $t('role.' . $member['role']) ?></td>
            <td><?php if ($viewer->can('members.remove')): ?><button name="remove"><?= $t('members.remove') ?></button><?php endif ?></td>
        </tr>
    <?php endforeach ?>
    </tbody>
</table>

<h2><?= $t('members.pending') ?></h2>
<?php foreach ($invitations as $invitation): ?>
    <p><?= htmlspecialchars($invitation['email']) ?> · <?= htmlspecialchars($invitation['sent']) ?></p>
<?php endforeach ?>
