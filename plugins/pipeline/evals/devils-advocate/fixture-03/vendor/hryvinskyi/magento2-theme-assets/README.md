# ThemeAssets Magento 2 / Adobe Commerce

A Magento 2 module that provides asset rendering functionality for scripts, stylesheets, and asset path resolution.

## Features

- **Asset Rendering**: Render JavaScript and CSS assets with multiple loading strategies
- **Inline & External**: Support for both inline and external asset rendering
- **Loading Strategies**: Sync, async, and defer loading for scripts
- **Preloading**: Resource preload hints with fetch priority support
- **Content Strategies**: Multiple fallback strategies for asset content retrieval
- **Caching**: Built-in asset caching for improved performance

## Installation

### Via Composer

```bash
composer require hryvinskyi/magento2-theme-assets
```

### Manual Installation

1. Create the directory `app/code/Hryvinskyi/ThemeAssets`
2. Copy the module files to the directory
3. Run the following commands:

```bash
bin/magento module:enable Hryvinskyi_ThemeAssets
bin/magento setup:upgrade
bin/magento cache:flush
```

## Requirements

- PHP ^8.1
- Magento 2.4.x
- hryvinskyi/magento2-head-tag-manager

## Usage

### In PHTML Templates

```php
<?php
use Hryvinskyi\ThemeAssets\Api\AssetRendererInterface;

/** @var \Hryvinskyi\Base\Model\ViewModelRegistry $viewModels */
$assetRenderer = $viewModels->require(AssetRendererInterface::class);

// Render inline script
echo $assetRenderer->renderScript('Module_Name::js/script.js');

// Render external script with async loading
echo $assetRenderer->renderScript(
    'Module_Name::js/script.js',
    AssetRendererInterface::RENDER_EXTERNAL,
    AssetRendererInterface::LOAD_ASYNC
);

// Render external script with defer and preload
echo $assetRenderer->renderScript(
    'Module_Name::js/script.js',
    AssetRendererInterface::RENDER_EXTERNAL,
    AssetRendererInterface::LOAD_DEFER,
    AssetRendererInterface::PRELOAD_ENABLED,
    [],
    ['priority' => AssetRendererInterface::PRIORITY_HIGH]
);

// Render inline stylesheet
echo $assetRenderer->renderStyle('Module_Name::css/styles.css');

// Render external stylesheet with preload
echo $assetRenderer->renderStyle(
    'Module_Name::css/styles.css',
    AssetRendererInterface::RENDER_EXTERNAL,
    AssetRendererInterface::PRELOAD_ENABLED
);

// Get raw file content
$content = $assetRenderer->getContent('Module_Name::js/config.json');
```

### Constants

#### Render Types
- `AssetRendererInterface::RENDER_INLINE` - Inline the asset content
- `AssetRendererInterface::RENDER_EXTERNAL` - Link to external file

#### Load Strategies (for scripts)
- `AssetRendererInterface::LOAD_SYNC` - Synchronous loading (blocking)
- `AssetRendererInterface::LOAD_ASYNC` - Asynchronous loading
- `AssetRendererInterface::LOAD_DEFER` - Deferred loading

#### Preload Options
- `AssetRendererInterface::PRELOAD_ENABLED` - Enable resource preloading
- `AssetRendererInterface::PRELOAD_DISABLED` - Disable resource preloading

#### Fetch Priority
- `AssetRendererInterface::PRIORITY_HIGH` - High fetch priority
- `AssetRendererInterface::PRIORITY_LOW` - Low fetch priority
- `AssetRendererInterface::PRIORITY_AUTO` - Browser default priority

### Options Array

The `$options` parameter supports:

```php
[
    'priority' => AssetRendererInterface::PRIORITY_HIGH, // Fetch priority for preload
    'attributes' => [                                     // Additional HTML attributes
        'data-custom' => 'value',
        'id' => 'my-script'
    ],
    'content_before' => '/* prefix */',                  // Content to prepend (inline only)
    'content_after' => '/* suffix */'                    // Content to append (inline only)
]
```

## Asset Content Strategies

The module uses a strategy pattern for retrieving asset content with multiple fallbacks:

1. **MagentoAssetSystemStrategy** - Uses Magento's built-in asset system
2. **DirectStaticFileStrategy** - Direct access to static file directory
3. **FilesystemServiceStrategy** - Filesystem service with absolute path

Strategies are tried in order until content is successfully retrieved.

## Logging

Asset retrieval failures are logged to `var/log/asset_renderer.log`.

## API Reference

### AssetRendererInterface

| Method | Description |
|--------|-------------|
| `createAsset(string $fileId, array $params = []): File` | Create and cache an asset |
| `renderScript(...)` | Render a JavaScript asset |
| `renderStyle(...)` | Render a CSS asset |
| `getContent(string $fileId, array $params = []): string` | Get raw file content |

### AssetPathResolverInterface

| Method | Description |
|--------|-------------|
| `getViewFilePath(string $fileId, array $params = []): string` | Get asset file path |
| `getViewFileContent(string $fileId, array $params = []): string\|false` | Get asset file content |
| `createAsset(string $fileId, array $params = []): File` | Create and cache an asset |

## License

MIT License

## Author

Volodymyr Hryvinskyi

GitHub: https://github.com/hryvinskyi
