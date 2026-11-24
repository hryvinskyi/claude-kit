<?php
/**
 * Team > Security.
 *
 * @var \Acme\Desk\Viewer $viewer
 * @var array{session_hours: int, two_step: bool} $settings
 * @var callable(string): string $t
 */
?>
<h1><?= $t('security.title') ?></h1>

<form method="post" action="/team/security">
    <label><?= $t('security.session_hours') ?>
        <input type="number" name="session_hours" min="1" max="72" value="<?= $settings['session_hours'] ?>">
    </label>
    <p><?= $t('security.session_hours.help') ?></p>

    <?php if ($viewer->can('security.two_step')): ?>
    <label><input type="checkbox" name="two_step" <?= $settings['two_step'] ? 'checked' : '' ?>> <?= $t('security.two_step') ?></label>
    <p><?= $t('security.two_step.help') ?></p>
    <?php endif ?>

    <button><?= $t('security.save') ?></button>
</form>
