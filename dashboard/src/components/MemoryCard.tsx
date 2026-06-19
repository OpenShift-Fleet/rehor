import type { Memory } from '../types';
import { sourceUrl, displayKey } from '../utils';

interface Props {
  memory: Memory;
  selected?: boolean;
  showSimilarity?: boolean;
  onClick?: () => void;
}

const categoryColors: Record<string, string> = {
  learning: 'green',
  review_feedback: 'yellow',
  codebase_pattern: 'blue',
};

export default function MemoryCard({ memory, selected, showSimilarity, onClick }: Props) {
  const preview = memory.content.length > 150
    ? memory.content.slice(0, 150) + '...'
    : memory.content;

  const badgeClass = categoryColors[memory.category] || 'green';

  return (
    <div
      className={`memory-card${selected ? ' selected' : ''}`}
      onClick={onClick}
    >
      <div className="memory-card-title">{memory.title}</div>
      <div className="memory-card-content">{preview}</div>
      <div className="memory-card-footer">
        <span className={`category-badge ${badgeClass}`}>
          {memory.category.replace(/_/g, ' ')}
        </span>
        {memory.repo && <span className="memory-repo">{memory.repo}</span>}
        {displayKey(memory) && (
          <a
            href={sourceUrl(memory) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {displayKey(memory)}
          </a>
        )}
        {memory.tags.length > 0 && (
          <span className="memory-tags">
            {memory.tags.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </span>
        )}
        {showSimilarity && memory.similarity != null && (
          <span className="similarity-score">
            {(memory.similarity * 100).toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  );
}
