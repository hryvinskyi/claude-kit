<?php

declare(strict_types=1);

namespace Acme\Notes\Controller;

use Acme\Notes\Entity\Note;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Http\Attribute\IsGranted;

class NoteController extends AbstractController
{
    #[Route('/notes', name: 'note_list')]
    public function list(): Response
    {
        return $this->render('note/list.html.twig', ['notes' => []]);
    }

    #[Route('/notes/new', name: 'note_new')]
    public function new(): Response
    {
        return $this->render('note/edit.html.twig');
    }

    #[Route('/notes/{id}/edit', name: 'note_edit')]
    #[IsGranted('NOTE_EDIT', 'note', message: 'notes.only_author')]
    public function edit(Note $note): Response
    {
        return $this->render('note/edit.html.twig', ['note' => $note]);
    }
}
