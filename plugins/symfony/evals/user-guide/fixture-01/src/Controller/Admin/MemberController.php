<?php

declare(strict_types=1);

namespace Acme\Notes\Controller\Admin;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

class MemberController extends AbstractController
{
    #[Route('/admin/members', name: 'admin_members', methods: ['GET'])]
    public function index(): Response
    {
        return $this->render('admin/members.html.twig', ['members' => []]);
    }

    #[Route('/admin/members/invite', name: 'admin_members_invite', methods: ['POST'])]
    public function invite(): Response
    {
        $this->addFlash('success', 'members.invited');

        return $this->redirectToRoute('admin_members');
    }
}
