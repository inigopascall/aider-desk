/** Fed to `php` on stdin in a Laravel project root. Prints one JSON object on stdout; each section fails on its own. */
export const LARAVEL_EXPORT_PHP_SCRIPT = String.raw`<?php
// AiderDesk repository mappings: Laravel export.
ini_set('display_errors', 'stderr');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);

$result = ['version' => 1, 'php' => PHP_VERSION, 'laravel' => null, 'error' => null, 'sections' => []];

$emit = function () use (&$result) {
    echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
};

try {
    if (!is_file(getcwd() . '/vendor/autoload.php')) {
        throw new RuntimeException('vendor/autoload.php not found; run composer install');
    }
    require getcwd() . '/vendor/autoload.php';
    $app = require getcwd() . '/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $result['laravel'] = $app->version();
} catch (Throwable $e) {
    $result['error'] = 'boot: ' . get_class($e) . ': ' . $e->getMessage();
    $emit();
    exit(0);
}

$relative = function ($path) {
    $base = rtrim(base_path(), '/') . '/';
    return is_string($path) && strpos($path, $base) === 0 ? substr($path, strlen($base)) : $path;
};

$run = function ($name, callable $fn) use (&$result) {
    try {
        $result['sections'][$name] = ['ok' => true, 'data' => $fn()];
    } catch (Throwable $e) {
        $result['sections'][$name] = ['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()];
    }
};

$artisanJson = function ($command, array $args = []) {
    $code = Illuminate\Support\Facades\Artisan::call($command, $args + ['--json' => true]);
    $out = Illuminate\Support\Facades\Artisan::output();
    $decoded = json_decode($out, true);
    if ($code !== 0 || $decoded === null) {
        throw new RuntimeException($command . ' exited ' . $code . ': ' . substr(trim($out), 0, 500));
    }
    return $decoded;
};

$run('routes', function () use ($artisanJson) {
    return $artisanJson('route:list');
});

$run('models', function () use ($artisanJson, $relative) {
    $models = [];
    $dir = is_dir(app_path('Models')) ? app_path('Models') : app_path();
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($files as $file) {
        if ($file->getExtension() !== 'php') {
            continue;
        }
        $class = app()->getNamespace() . str_replace('/', '\\', substr($file->getPathname(), strlen(app_path()) + 1, -4));
        $path = $relative($file->getPathname());
        try {
            if (!class_exists($class) || !is_subclass_of($class, Illuminate\Database\Eloquent\Model::class) || (new ReflectionClass($class))->isAbstract()) {
                continue;
            }
        } catch (Throwable $e) {
            continue;
        }
        try {
            $models[$class] = $artisanJson('model:show', ['model' => $class]) + ['file' => $path];
        } catch (Throwable $e) {
            $models[$class] = ['error' => $e->getMessage(), 'file' => $path];
        }
    }
    return $models;
});

$run('schema', function () use ($artisanJson) {
    $connection = Illuminate\Support\Facades\DB::connection();
    $driver = $connection->getDriverName();
    $database = $connection->getDatabaseName();
    $schema = Illuminate\Support\Facades\Schema::getFacadeRoot();
    $meta = ['connection' => $connection->getName(), 'driver' => $driver];
    if (method_exists($schema, 'getTables') && method_exists($schema, 'getColumns') && method_exists($schema, 'getForeignKeys')) {
        $tables = [];
        foreach ($schema->getTables() as $table) {
            $tableSchema = isset($table['schema']) ? $table['schema'] : null;
            if (in_array($driver, ['mysql', 'mariadb'], true) && $tableSchema !== null && $tableSchema !== $database) {
                continue;
            }
            $name = $table['name'];
            try {
                $tables[$name] = [
                    'columns' => $schema->getColumns($name),
                    'indexes' => method_exists($schema, 'getIndexes') ? $schema->getIndexes($name) : [],
                    'foreign_keys' => $schema->getForeignKeys($name),
                ];
            } catch (Throwable $e) {
                $tables[$name] = ['error' => $e->getMessage()];
            }
        }
        return $meta + ['via' => 'schema-builder', 'tables' => $tables];
    }
    $db = $artisanJson('db:show');
    $tables = [];
    foreach (isset($db['tables']) ? $db['tables'] : [] as $table) {
        $name = isset($table['table']) ? $table['table'] : (isset($table['name']) ? $table['name'] : null);
        if ($name === null) {
            continue;
        }
        try {
            $tables[$name] = $artisanJson('db:table', ['table' => $name]);
        } catch (Throwable $e) {
            $tables[$name] = ['error' => $e->getMessage()];
        }
    }
    return $meta + ['via' => 'db:table', 'tables' => $tables];
});

$emit();
`;
