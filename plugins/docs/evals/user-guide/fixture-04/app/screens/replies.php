<?php
/**
 * Inbox > Templates.
 *
 * @var list<array{title: string, text: string}> $replies
 * @var callable(string): string $t
 */
?>
<h1><?= $t('replies.title') ?></h1>
<a href="/inbox/replies/new"><?= $t('replies.new') ?></a>
<?php foreach ($replies as $reply): ?>
    <article>
        <h2><?= htmlspecialchars($reply['title']) ?></h2>
        <p><?= htmlspecialchars($reply['text']) ?></p>
    </article>
<?php endforeach ?>
<?php if ($replies === []): ?>
<p><?= $t('replies.none') ?></p>
<?php endif ?>
