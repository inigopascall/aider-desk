export const LARAVEL_MAPPING_FILES = ['schema.md', 'models.md', 'routes.md'] as const;
export type LaravelMappingFile = (typeof LARAVEL_MAPPING_FILES)[number];

export interface LaravelMappingsOutput {
  /** Set when the app could not boot; nothing else is produced. */
  bootError?: string;
  /** Content for each section that succeeded. */
  files: Partial<Record<LaravelMappingFile, string>>;
  /** Error message for each section that failed. */
  failures: Partial<Record<LaravelMappingFile, string>>;
}

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown): RecordValue => (isRecord(value) ? value : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const values = (value: unknown): unknown[] => (Array.isArray(value) ? value : Object.values(record(value)));
const basename = (value: unknown): string => text(value).split('\\').pop() ?? '';
const shortClass = (value: unknown): string => {
  let className = text(value);
  if (className.startsWith('App\\Models\\')) {
    className = className.slice('App\\Models\\'.length);
  } else if (className.startsWith('App\\')) {
    className = className.slice('App\\'.length);
  }
  return basename(className);
};
const hasAttribute = (value: unknown, attribute: string): boolean => values(value).some((item) => item === attribute);
const joinedColumns = (value: unknown): string => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('+') : '');

export const parseLaravelExportOutput = (stdout: string): unknown => {
  const start = stdout.indexOf('{');
  try {
    if (start < 0) {
      throw new Error();
    }
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`Unable to parse Laravel export output: ${stdout.slice(0, 300)}`);
  }
};

const formatSchemaTable = (tableName: string, value: unknown): string => {
  const table = record(value);
  if (text(table.error)) {
    return `${tableName}: (error: ${text(table.error)})`;
  }
  const arrayShape = Array.isArray(table.columns);
  const columns = values(table.columns);
  const indexes = values(table.indexes);
  const primary = indexes.find((item) => record(item).primary === true || hasAttribute(record(item).attributes, 'primary'));
  const primaryColumns = joinedColumns(record(primary).columns);
  const columnText = columns.map((item) => {
    const column = record(item);
    const name = text(arrayShape ? column.name : column.column);
    const nullable = arrayShape ? column.nullable === true : hasAttribute(column.attributes, 'nullable');
    const type = `${text(column.type)}${!arrayShape && hasAttribute(column.attributes, 'unsigned') ? ' unsigned' : ''}`;
    const primaryMark = primaryColumns.split('+').includes(name) ? '*' : '';
    const defaultText = column.default !== null && column.default !== undefined ? `=${String(column.default)}` : '';
    return `${nullable ? '' : '!'}${primaryMark}${name} ${type}${defaultText}`;
  });
  const foreignKeys = values(table.foreign_keys).map((item) => {
    const foreignKey = record(item);
    return `${joinedColumns(foreignKey.columns ?? foreignKey.local_columns)} → ${text(foreignKey.foreign_table)}.${joinedColumns(foreignKey.foreign_columns)}`;
  });
  const foreignColumnSets = values(table.foreign_keys).map((item) => joinedColumns(record(item).columns ?? record(item).local_columns));
  const uniqueIndexes: string[] = [];
  const regularIndexes: string[] = [];
  for (const item of indexes) {
    const index = record(item);
    const columnsText = joinedColumns(index.columns);
    const primaryIndex = index.primary === true || hasAttribute(index.attributes, 'primary');
    const unique = index.unique === true || hasAttribute(index.attributes, 'unique');
    if (!columnsText || primaryIndex || (!unique && foreignColumnSets.includes(columnsText))) {
      continue;
    }
    (unique ? uniqueIndexes : regularIndexes).push(columnsText);
  }
  const segments = [
    uniqueIndexes.length ? `UQ: ${uniqueIndexes.join(', ')}` : '',
    regularIndexes.length ? `IDX: ${regularIndexes.join(', ')}` : '',
    foreignKeys.length ? `FK: ${foreignKeys.join(', ')}` : '',
  ].filter(Boolean);
  return `${tableName}: ${columnText.join(', ')}${segments.length ? ` | ${segments.join(' | ')}` : ''}`;
};

const formatSchemaFile = (data: RecordValue, header: string): string => {
  const metadata = [text(data.php) ? `PHP ${text(data.php)}` : '', text(data.laravel) ? `Laravel ${text(data.laravel)}` : ''];
  const driver = text(data.driver);
  const connection = text(data.connection);
  if (driver) {
    metadata.push(`${driver} (connection ${connection})`);
  }
  const lines = [
    '# Database schema',
    header,
    metadata.filter(Boolean).join(' · '),
    'Legend: ! NOT NULL · * primary key · =x default · UQ unique index · IDX index · FK foreign key',
    '',
  ];
  lines.push(
    ...Object.keys(record(data.tables))
      .sort()
      .map((name) => formatSchemaTable(name, record(data.tables)[name])),
  );
  return `${lines.join('\n')}\n`;
};

const formatModelFile = (data: unknown, header: string): string => {
  const lines = ['# Eloquent models', header, 'Column types are in schema.md. "fillable: all" means nothing is guarded.', ''];
  for (const [className, value] of Object.entries(record(data)).sort(([a], [b]) => shortClass(a).localeCompare(shortClass(b)))) {
    const model = record(value);
    const name = shortClass(className);
    const file = text(model.file);
    lines.push(`${name}${text(model.table) ? ` [${text(model.table)}]` : ''}${file ? ` ${file}` : ''}`);
    if (text(model.error)) {
      lines.push(`  error: ${text(model.error)}`, '');
      continue;
    }
    const attributes = values(model.attributes).map(record);
    const nonAppended = attributes.filter((attribute) => !attribute.appended);
    const fillable = nonAppended.filter((attribute) => attribute.fillable === true).map((attribute) => text(attribute.name));
    const segments: string[] = [];
    if (fillable.length) {
      segments.push(`fillable: ${fillable.length === nonAppended.length ? 'all' : fillable.join(', ')}`);
    }
    for (const [label, key] of [
      ['hidden', 'hidden'],
      ['appended', 'appended'],
    ] as const) {
      const names = attributes.filter((attribute) => Boolean(attribute[key])).map((attribute) => text(attribute.name));
      if (names.length) {
        segments.push(`${label}: ${names.join(', ')}`);
      }
    }
    const casts = attributes
      .filter((attribute) => {
        const cast = text(attribute.cast);
        return (
          cast &&
          !(attribute.increments === true && ['int', 'integer'].includes(cast)) &&
          !(['created_at', 'updated_at', 'deleted_at'].includes(text(attribute.name)) && ['datetime', 'immutable_datetime'].includes(cast))
        );
      })
      .map((attribute) => `${text(attribute.name)}→${basename(attribute.cast)}`);
    if (casts.length) {
      segments.push(`casts: ${casts.join(', ')}`);
    }
    const observers = [
      ...new Set(
        values(model.observers).flatMap((item) =>
          (typeof item === 'string' ? [item] : values(record(item).observer)).filter((item): item is string => typeof item === 'string').map(basename),
        ),
      ),
    ];
    if (observers.length) {
      segments.push(`observers: ${observers.join(', ')}`);
    }
    const events = values(model.events).map((item) => `${text(record(item).event)}→${basename(record(item).class)}`);
    if (events.length) {
      segments.push(`events: ${events.join(', ')}`);
    }
    if (text(model.policy)) {
      segments.push(`policy: ${basename(model.policy)}`);
    }
    if (segments.length) {
      lines.push(`  ${segments.join(' | ')}`);
    }
    const relations = values(model.relations).map((item) => `${text(record(item).name)} ${text(record(item).type)} ${shortClass(record(item).related)}`);
    if (relations.length) {
      lines.push(`  rel: ${relations.join(' · ')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
};

const formatRoutesFile = (data: unknown, header: string): string => {
  const routes = values(data)
    .filter((item) => {
      const action = text(record(item).action);
      return !(action.includes('\\') && !action.startsWith('App\\'));
    })
    .map((item) => {
      const route = record(item);
      const uri = `${text(route.domain) ? `${text(route.domain)}/` : ''}${text(route.uri)}`;
      let action = text(route.action).replace(/^App\\Http\\Controllers\\/, '');
      if (action === 'Closure' && text(route.path)) {
        action += ` (${text(route.path)})`;
      }
      let line = `${text(route.method)}  ${uri}  → ${action}`;
      if (text(route.name)) {
        line += `  (${text(route.name)})`;
      }
      const middleware = values(route.middleware)
        .filter((item): item is string => typeof item === 'string')
        .map((item) => {
          const separator = item.indexOf(':');
          return item.includes('\\') ? `${basename(separator < 0 ? item : item.slice(0, separator))}${separator < 0 ? '' : item.slice(separator)}` : item;
        });
      if (middleware.length) {
        line += `  [${middleware.join(', ')}]`;
      }
      return { uri, method: text(route.method), line };
    })
    .sort((a, b) => a.uri.localeCompare(b.uri) || a.method.localeCompare(b.method));
  return `${['# Routes', header, 'Routes defined by vendor packages are left out. Middleware is shown by class name.', '', ...routes.map((route) => route.line)].join('\n')}\n`;
};

export const formatLaravelMappings = (data: unknown, header: string): LaravelMappingsOutput => {
  if (!isRecord(data)) {
    return { bootError: 'Unexpected output from the Laravel export', files: {}, failures: {} };
  }
  if (text(data.error)) {
    return { bootError: text(data.error), files: {}, failures: {} };
  }
  const output: LaravelMappingsOutput = { files: {}, failures: {} };
  const sections = record(data.sections);
  for (const [sectionName, file] of [
    ['schema', 'schema.md'],
    ['models', 'models.md'],
    ['routes', 'routes.md'],
  ] as const) {
    const section = record(sections[sectionName]);
    if (section.ok !== true) {
      output.failures[file] = text(section.error) || 'Section missing from the export';
    } else if (sectionName === 'schema') {
      output.files[file] = formatSchemaFile({ ...record(section.data), php: data.php, laravel: data.laravel }, header);
    } else if (sectionName === 'models') {
      output.files[file] = formatModelFile(section.data, header);
    } else {
      output.files[file] = formatRoutesFile(section.data, header);
    }
  }
  return output;
};
