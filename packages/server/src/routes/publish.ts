import { Hono } from 'hono';
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { DocumentIndex } from '../services/index';

interface TagDoc {
  path: string;
  title: string;
  type: string;
}

// Tag metadata for enhanced display
const TAG_METADATA: Record<string, { symbol: string; desc: string }> = {
  sovereignty: { symbol: '⊕', desc: 'Systems carry their own context; no external authority dependencies' },
  overcomer: { symbol: '∞→0', desc: 'The infinite placed at the humble point' },
  irreducibility: { symbol: 'Σ→1', desc: 'Compress to the generative minimum' },
  theology: { symbol: '†', desc: 'Biblical and theological patterns' },
  devops: { symbol: '⚙', desc: 'Deployment, infrastructure, operations' },
  flutter: { symbol: '📱', desc: 'Flutter/Dart mobile development' },
  web3: { symbol: '⛓', desc: 'Ethereum, blockchain, decentralized systems' },
  obsidian: { symbol: '💎', desc: 'Obsidian configuration and workflows' },
  'claude-code': { symbol: '🤖', desc: 'Claude Code tooling and patterns' },
  latex: { symbol: '📄', desc: 'LaTeX typesetting and documents' },
  hooks: { symbol: '🪝', desc: 'Claude Code hooks system' },
  tooling: { symbol: '🔧', desc: 'Development tools and utilities' },
  'local-first': { symbol: '⊕', desc: 'Offline-capable, data sovereign applications' },
  architecture: { symbol: '≡', desc: 'System design and structure' },
  patterns: { symbol: '◇', desc: 'Reusable design patterns' },
};

function generateTagPage(tag: string, docs: TagDoc[]): string {
  const meta = TAG_METADATA[tag] || { symbol: '#', desc: `Documents tagged with #${tag}` };
  const today = new Date().toISOString().split('T')[0];

  // Sort docs by type, then title
  const typeOrder: Record<string, number> = { knowledge: 0, project: 1, task: 2, inbox: 3, unknown: 9 };
  const sorted = [...docs].sort((a, b) => {
    const typeA = typeOrder[a.type] ?? 5;
    const typeB = typeOrder[b.type] ?? 5;
    if (typeA !== typeB) return typeA - typeB;
    return a.title.localeCompare(b.title);
  });

  // Group by type
  const byType: Record<string, TagDoc[]> = {};
  for (const doc of sorted) {
    const type = doc.type || 'unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(doc);
  }

  const lines = [
    '---',
    'type: tag-index',
    `tag: ${tag}`,
    `generated: ${today}`,
    'publish: true',
    '---',
    '',
    `# ${meta.symbol} ${tag.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
    '',
    `*${meta.desc}*`,
    '',
    `**${docs.length} documents** with this tag.`,
    '',
  ];

  const typeLabels: Record<string, string> = {
    knowledge: 'Knowledge',
    project: 'Projects',
    task: 'Tasks',
    inbox: 'Inbox',
    unknown: 'Other',
  };

  for (const docType of ['knowledge', 'project', 'task', 'inbox', 'unknown']) {
    const typeDocs = byType[docType];
    if (typeDocs && typeDocs.length > 0) {
      lines.push(`## ${typeLabels[docType] || docType}`);
      lines.push('');
      for (const doc of typeDocs) {
        // Use filename without extension for wikilink
        const linkName = doc.path.replace(/\.md$/, '').split('/').pop() || doc.title;
        lines.push(`- [[${linkName}]]`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Auto-generated from frontmatter tags. Last updated: ${today}*`);

  return lines.join('\n');
}

export function createPublishRoutes(index: DocumentIndex, orgRoot: string) {
  const app = new Hono();
  const tagsDir = join(orgRoot, 'tags');

  // POST /api/publish/tags - Generate tag index pages
  app.post('/tags', async (c) => {
    const start = Date.now();

    // Ensure tags directory exists
    if (!existsSync(tagsDir)) {
      mkdirSync(tagsDir, { recursive: true });
    }

    // Build tag -> documents mapping
    const tagDocs: Record<string, TagDoc[]> = {};
    const docs = index.getAll();

    for (const doc of docs) {
      // Skip tag-index files and certain special files
      if (doc.type === 'tag-index' || doc.path.startsWith('tags/')) {
        continue;
      }

      for (const tag of doc.tags) {
        const normalizedTag = tag.toLowerCase().trim();
        if (!normalizedTag) continue;

        if (!tagDocs[normalizedTag]) {
          tagDocs[normalizedTag] = [];
        }
        tagDocs[normalizedTag].push({
          path: doc.path,
          title: doc.title,
          type: doc.type,
        });
      }
    }

    // Generate tag pages
    const generated: string[] = [];
    const unchanged: string[] = [];

    for (const [tag, docs] of Object.entries(tagDocs)) {
      const tagFile = join(tagsDir, `${tag}.md`);
      const content = generateTagPage(tag, docs);

      // Check if content changed (compare without date line)
      if (existsSync(tagFile)) {
        const existing = await Bun.file(tagFile).text();
        const existingNoDate = existing.split('\n').slice(5).join('\n');
        const newNoDate = content.split('\n').slice(5).join('\n');
        if (existingNoDate === newNoDate) {
          unchanged.push(tag);
          continue;
        }
      }

      writeFileSync(tagFile, content, 'utf-8');
      generated.push(tag);
    }

    // Clean up orphaned tag pages
    const removed: string[] = [];
    if (existsSync(tagsDir)) {
      for (const file of readdirSync(tagsDir)) {
        if (!file.endsWith('.md')) continue;
        const tagName = file.replace('.md', '');
        if (!tagDocs[tagName]) {
          unlinkSync(join(tagsDir, file));
          removed.push(tagName);
        }
      }
    }

    const duration = Date.now() - start;

    return c.json({
      success: true,
      duration,
      stats: {
        totalTags: Object.keys(tagDocs).length,
        generated: generated.length,
        unchanged: unchanged.length,
        removed: removed.length,
      },
      generated,
      removed,
    });
  });

  // GET /api/publish/tags/stats - Get tag statistics
  app.get('/tags/stats', (c) => {
    const tagCounts: Record<string, number> = {};
    const docs = index.getAll();

    for (const doc of docs) {
      if (doc.type === 'tag-index') continue;
      for (const tag of doc.tags) {
        const normalizedTag = tag.toLowerCase().trim();
        if (!normalizedTag) continue;
        tagCounts[normalizedTag] = (tagCounts[normalizedTag] || 0) + 1;
      }
    }

    // Sort by count descending
    const sorted = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));

    return c.json({
      totalTags: sorted.length,
      totalUsages: sorted.reduce((sum, t) => sum + t.count, 0),
      tags: sorted,
    });
  });

  return app;
}
