<?php

declare(strict_types=1);

namespace Acme\Notes\Security\Voter;

use Acme\Notes\Entity\Note;
use Acme\Notes\Security\Member;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Authorization\Voter\Voter;

/**
 * Decides who may edit a note: its author, and nobody else of the workspace.
 *
 * @extends Voter<string, Note>
 */
class NoteVoter extends Voter
{
    public const string EDIT = 'NOTE_EDIT';

    protected function supports(string $attribute, mixed $subject): bool
    {
        return $attribute === self::EDIT && $subject instanceof Note;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool
    {
        $member = $token->getUser();
        if (!$member instanceof Member) {
            return false;
        }

        if (\in_array('ROLE_STAFF', $token->getRoleNames(), true)) {
            return true;
        }

        return $subject->getAuthorId() === $member->getId();
    }
}
