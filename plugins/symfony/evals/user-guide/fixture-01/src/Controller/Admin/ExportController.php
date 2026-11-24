<?php

declare(strict_types=1);

namespace Acme\Notes\Controller\Admin;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Http\Attribute\IsGranted;

#[IsGranted('ROLE_STAFF')]
class ExportController extends AbstractController
{
    #[Route('/admin/export', name: 'admin_export', methods: ['GET'])]
    public function index(): Response
    {
        return $this->render('admin/export.html.twig');
    }

    #[Route('/admin/export', name: 'admin_export_start', methods: ['POST'])]
    public function start(): Response
    {
        $this->addFlash('success', 'export.started');

        return $this->redirectToRoute('admin_export');
    }
}
