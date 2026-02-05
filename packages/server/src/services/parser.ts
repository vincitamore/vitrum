import matter from 'gray-matter';
import { readFileSync, statSync } from 'fs';
import { basename, dirname, relative } from 'path';
import type { OrgDocument } from '../types';

export interface TocEntry {
  level: number;
  text: string;
  slug: string;
}

export function parseDocument(filePath: string, orgRoot: string): OrgDocument {
  const raw = readFileSync(filePath, 'utf-8');
  const stats = statSync(filePath);
  const { data: frontmatter, content } = matter(raw);

  const relativePath = relative(orgRoot, filePath).replace(/\\/g, '/');
  const title = extractTitle(frontmatter, content, filePath);
  const links = extractWikilinks(content);
  const type = inferType(relativePath, frontmatter);
  const excerpt = extractExcerpt(content);

  return {
    path: relativePath,
    title,
    type,
    status: frontmatter.status as string | undefined,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    created: frontmatter.created || stats.birthtime.toISOString(),
    updated: stats.mtime.toISOString(),
    excerpt,
    frontmatter,
    content,
    links,
    backlinks: [], // Computed later by index
  };
}

function extractTitle(
  frontmatter: Record<string, unknown>,
  content: string,
  filePath: string
): string {
  // Try frontmatter title
  if (frontmatter.title && typeof frontmatter.title === 'string') {
    return frontmatter.title;
  }

  // Try first H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Fall back to filename
  return basename(filePath, '.md')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function extractWikilinks(content: string): string[] {
  const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links: string[] = [];
  let match;

  while ((match = linkPattern.exec(content)) !== null) {
    const link = match[1].trim();
    if (!links.includes(link)) {
      links.push(link);
    }
  }

  return links;
}

function inferType(
  relativePath: string,
  frontmatter: Record<string, unknown>
): OrgDocument['type'] {
  // Check frontmatter type first
  if (frontmatter.type) {
    const t = String(frontmatter.type).toLowerCase();
    // Map tag-index to tag for graph coloring
    if (t === 'tag-index' || t === 'tag') {
      return 'tag';
    }
    if (['task', 'knowledge', 'inbox', 'reminder', 'project'].includes(t)) {
      return t as OrgDocument['type'];
    }
  }

  // Infer from path
  const dir = dirname(relativePath).split('/')[0];
  switch (dir) {
    case 'tasks':
      return 'task';
    case 'knowledge':
      return 'knowledge';
    case 'inbox':
      return 'inbox';
    case 'reminders':
      return 'reminder';
    case 'projects':
      return 'project';
    case 'tags':
      return 'tag';
    default:
      return 'other';
  }
}

function extractExcerpt(content: string, maxLength = 200): string {
  // Remove frontmatter delimiter if still present
  let text = content.replace(/^---[\s\S]*?---\n?/, '');

  // Remove headings
  text = text.replace(/^#+\s+.+$/gm, '');

  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');

  // Remove inline code
  text = text.replace(/`[^`]+`/g, '');

  // Remove links but keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2 || $1');

  // Remove markdown formatting
  text = text.replace(/[*_~]+([^*_~]+)[*_~]+/g, '$1');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxLength) {
    return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
  }

  return text;
}

export function buildToc(content: string): TocEntry[] {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  const toc: TocEntry[] = [];
  let match;

  while ((match = headingPattern.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    const slug = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');

    toc.push({ level, text, slug });
  }

  return toc;
}
