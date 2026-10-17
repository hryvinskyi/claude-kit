<?php
/**
 * Copyright (c) 2026. Volodymyr Hryvinskyi. All rights reserved.
 * Author: Volodymyr Hryvinskyi
 * GitHub: https://github.com/hryvinskyi
 */

declare(strict_types=1);

namespace Hryvinskyi\ThemeAssets\Api;

use Magento\Framework\View\Asset\File;

/**
 * Interface for rendering scripts, stylesheets and resolving asset file paths
 */
interface AssetRendererInterface
{
    /**
     * Script rendering types
     */
    public const RENDER_INLINE = 'inline';
    public const RENDER_EXTERNAL = 'external';

    /**
     * External script loading strategies
     */
    public const LOAD_SYNC = 'sync';
    public const LOAD_ASYNC = 'async';
    public const LOAD_DEFER = 'defer';

    /**
     * Resource preloading options
     */
    public const PRELOAD_ENABLED = true;
    public const PRELOAD_DISABLED = false;

    /**
     * Fetch priority options for preload
     */
    public const PRIORITY_LOW = 'low';
    public const PRIORITY_HIGH = 'high';
    public const PRIORITY_AUTO = 'auto';

    /**
     * Create and cache asset by file ID
     *
     * @param string $fileId The file identifier (e.g., 'images/logo.svg')
     * @param array{_secure?: bool, area?: string, theme?: string, locale?: string, module?: string} $params Asset parameters
     * @return File The created asset
     * @throws \Magento\Framework\Exception\LocalizedException If the asset cannot be resolved
     */
    public function createAsset(string $fileId, array $params = []): File;

    /**
     * Render JavaScript asset with specified method
     *
     * @param string $fileId The file identifier (e.g., 'js/script.js')
     * @param string $renderType Rendering type (inline or external)
     * @param string $loadStrategy Loading strategy for external scripts (sync, async, defer)
     * @param bool $preload Whether to add preload resource hint
     * @param array{_secure?: bool, area?: string, theme?: string, locale?: string, module?: string} $params Asset parameters
     * @param array{priority?: string, attributes?: array<string, string>, position?: string, content_before?: string, content_after?: string} $options Rendering options
     * @return string The rendered script tag or empty string for non-inline methods that use HeadTagManager
     * @throws \Magento\Framework\Exception\LocalizedException If the asset cannot be resolved
     */
    public function renderScript(
        string $fileId,
        string $renderType = self::RENDER_INLINE,
        string $loadStrategy = self::LOAD_SYNC,
        bool $preload = self::PRELOAD_DISABLED,
        array $params = [],
        array $options = []
    ): string;

    /**
     * Render CSS asset with specified method
     *
     * @param string $fileId The file identifier (e.g., 'css/styles.css')
     * @param string $renderType Rendering type (inline or external)
     * @param bool $preload Whether to add preload resource hint
     * @param array{_secure?: bool, area?: string, theme?: string, locale?: string, module?: string} $params Asset parameters
     * @param array{priority?: string, attributes?: array<string, string>, position?: string} $options Rendering options
     * @return string The rendered style tag or empty string for non-inline methods that use HeadTagManager
     * @throws \Magento\Framework\Exception\LocalizedException If the asset cannot be resolved
     */
    public function renderStyle(
        string $fileId,
        string $renderType = self::RENDER_INLINE,
        bool $preload = self::PRELOAD_DISABLED,
        array $params = [],
        array $options = []
    ): string;

    /**
     * Get content from theme file
     *
     * @param string $fileId The asset to read
     * @param array $params The params for asset
     * @return string The file content or empty string if unavailable
     * @throws \Magento\Framework\Exception\LocalizedException If the asset cannot be resolved
     */
    public function getContent(string $fileId, array $params = []): string;
}
