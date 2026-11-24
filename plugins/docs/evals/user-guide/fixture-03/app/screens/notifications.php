<?php
/**
 * Account > Notifications.
 *
 * @var array{weekly_summary: bool} $settings
 * @var callable(string): string $t
 */
?>
<h1><?= $t('notifications.title') ?></h1>

<form method="post" action="/account/notifications">
    <label><input type="checkbox" name="weekly_summary" <?= $settings['weekly_summary'] ? 'checked' : '' ?>> <?= $t('notifications.weekly_summary') ?></label>
    <button><?= $t('notifications.save') ?></button>
</form>
