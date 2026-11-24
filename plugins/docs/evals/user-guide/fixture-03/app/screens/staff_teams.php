<?php
/**
 * Staff > Teams. Acme staff only.
 *
 * @var list<array{name: string, status: string}> $teams
 * @var callable(string): string $t
 */
?>
<h1><?= $t('staff.teams.title') ?></h1>
<table>
    <tbody>
    <?php foreach ($teams as $team): ?>
        <tr>
            <td><?= htmlspecialchars($team['name']) ?></td>
            <td><?= $t('staff.teams.status.' . $team['status']) ?></td>
            <td><button name="close"><?= $t('staff.teams.close') ?></button></td>
        </tr>
    <?php endforeach ?>
    </tbody>
</table>
