import { useState } from 'react';
import type { Memory } from '../types';
import { searchMemories, deleteMemory } from '../api';
import MemoryCard from '../components/MemoryCard';
import DetailPanel from '../components/DetailPanel';
import { SearchInput } from '@patternfly/react-core';

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Memory[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Memory | null>(null);

  const doSearch = async () => {
    if (!query.trim()) return;
    const res = await searchMemories(query.trim());
    setResults(Array.isArray(res) ? res : res.items || []);
    setSearched(true);
    setSelected(null);
  };

  const handleDelete = async (id: number) => {
    await deleteMemory(id);
    setSelected(null);
    setResults((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <div className="split-layout">
      <div className="split-main">
        <div style={{ marginBottom: '16px' }}>
          <SearchInput
            placeholder="Search memories..."
            value={query}
            onChange={(_e, val) => setQuery(val)}
            onSearch={doSearch}
            onClear={() => setQuery('')}
          />
        </div>
        <div className="card-grid">
          {searched && results.length === 0 && (
            <div className="empty-state">No results found</div>
          )}
          {results.map((m) => (
            <MemoryCard
              key={m.id}
              memory={m}
              selected={selected?.id === m.id}
              showSimilarity
              onClick={() => setSelected(m)}
            />
          ))}
        </div>
      </div>
      {selected && (
        <div className="split-detail">
          <DetailPanel
            type="memory"
            memory={selected}
            onClose={() => setSelected(null)}
            onDelete={handleDelete}
          />
        </div>
      )}
    </div>
  );
}
