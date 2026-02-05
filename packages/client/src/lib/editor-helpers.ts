import type { EditorField, EditorData } from '../components/TuiEditor';
import type { OrgDocument } from './api';

/**
 * Get editor fields based on document type
 */
export function getEditorFields(docType: string): EditorField[] {
  const baseFields: EditorField[] = [
    { name: 'title', label: 'Title', type: 'text', required: true },
  ];

  switch (docType) {
    case 'task':
      return [
        ...baseFields,
        { name: 'status', label: 'Status', type: 'text', placeholder: 'active, blocked, complete, etc.' },
        { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'tag1, tag2, tag3' },
        { name: 'content', label: 'Content', type: 'textarea' },
      ];
    case 'knowledge':
      return [
        ...baseFields,
        { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'tag1, tag2, tag3' },
        { name: 'content', label: 'Content', type: 'textarea' },
      ];
    case 'inbox':
      return [
        ...baseFields,
        { name: 'source', label: 'Source', type: 'text', placeholder: 'email, capture, mobile' },
        { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'tag1, tag2, tag3' },
        { name: 'content', label: 'Content', type: 'textarea' },
      ];
    case 'reminder':
      return [
        ...baseFields,
        { name: 'status', label: 'Status', type: 'text', placeholder: 'pending, snoozed, completed' },
        { name: 'remindAt', label: 'Remind At', type: 'text', placeholder: '2026-02-06T09:00' },
        { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'tag1, tag2, tag3' },
        { name: 'content', label: 'Content', type: 'textarea' },
      ];
    default:
      return [
        ...baseFields,
        { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'tag1, tag2, tag3' },
        { name: 'content', label: 'Content', type: 'textarea' },
      ];
  }
}

/**
 * Convert OrgDocument to EditorData for the editor
 */
export function documentToEditorData(doc: OrgDocument): EditorData {
  // Extract title from content (first # heading) or use doc.title
  let title = doc.title;
  let bodyContent = doc.content || '';

  // Strip frontmatter if present (API may return content with frontmatter)
  bodyContent = bodyContent.replace(/^---[\s\S]*?---\n?/, '');

  // If content starts with # heading, extract it as title
  const lines = bodyContent.split('\n');
  if (lines[0]?.startsWith('# ')) {
    title = lines[0].substring(2).trim();
    // Remove the title line and any following blank line
    bodyContent = lines.slice(1).join('\n').replace(/^\n+/, '');
  }

  return {
    title,
    status: doc.status || '',
    tags: doc.tags?.join(', ') || '',
    content: bodyContent,
    source: '', // Will be populated from frontmatter if needed
    remindAt: '', // Will be populated from frontmatter if needed
  };
}

/**
 * Convert EditorData back to frontmatter and content for API
 */
export function editorDataToPayload(
  data: EditorData,
  originalDoc: OrgDocument
): { frontmatter: Record<string, unknown>; content: string } {
  // Parse tags from comma-separated string
  const tags = data.tags
    ? data.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  // Build frontmatter preserving original fields
  const frontmatter: Record<string, unknown> = {
    type: originalDoc.type,
    created: originalDoc.created || new Date().toISOString().split('T')[0],
  };

  // Add type-specific fields
  if (originalDoc.type === 'task') {
    frontmatter.status = data.status || 'active';
    frontmatter.completed = null;
  }

  if (originalDoc.type === 'reminder' && data.remindAt) {
    frontmatter['remind-at'] = data.remindAt;
    frontmatter.status = data.status || 'pending';
  }

  // Add tags if present
  if (tags.length > 0) {
    frontmatter.tags = tags;
  } else {
    frontmatter.tags = [];
  }

  // Add updated timestamp
  frontmatter.updated = new Date().toISOString().split('T')[0];

  // Build content with title as heading
  const content = `# ${data.title}\n\n${data.content || ''}`.trimEnd() + '\n';

  return { frontmatter, content };
}
