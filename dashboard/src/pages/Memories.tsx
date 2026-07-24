import { useEffect, useState, useCallback } from 'react';
import type { Memory } from '../types';
import { fetchMemories, deleteMemory, fetchStats, fetchTags } from '../api';
import MemoryCard from '../components/MemoryCard';
import DetailPanel from '../components/DetailPanel';
import Pagination from '../components/Pagination';
import {
  Flex,
  FlexItem,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectList,
  SelectOption
} from '@patternfly/react-core';

const CATEGORY_OPTIONS = [
  { value: '', label: 'All Categories' },
  { value: 'learning', label: 'Learning' },
  { value: 'review_feedback', label: 'Review Feedback' },
  { value: 'codebase_pattern', label: 'Codebase Pattern' },
];

const LIMIT = 20;

export default function Memories() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState('');
  const [repo, setRepo] = useState('');
  const [tag, setTag] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [isRepoOpen, setIsRepoOpen] = useState(false);
  const [isTagOpen, setIsTagOpen] = useState(false);

  useEffect(() => {
    fetchStats().then((s: any) => {
      if (s.repos) setRepos(s.repos);
    }).catch(() => {});
    fetchTags().then((t: any) => {
      if (Array.isArray(t)) setTags(t);
      else if (t?.tags) setTags(t.tags);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const res = await fetchMemories({
      category: category || undefined,
      repo: repo || undefined,
      tag: tag || undefined,
      limit: LIMIT,
      offset,
    });
    setMemories(res.items || []);
    setTotal(res.total || 0);
  }, [category, repo, tag, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (id: number) => {
    await deleteMemory(id);
    setSelected(null);
    load();
  };

  const categoryLabel = CATEGORY_OPTIONS.find((o) => o.value === category)?.label || 'All Categories';
  const repoLabel = repo || 'All Repos';
  const tagLabel = tag || 'All Tags';

  return (
    <div className="split-layout">
      <div className="split-main">
        <Flex gap={{ default: 'gapSm' }} style={{ marginBottom: '16px' }}>
          <FlexItem>
            <Select
              isOpen={isCategoryOpen}
              selected={category}
              onSelect={(_e, val) => { setCategory(val as string); setOffset(0); setIsCategoryOpen(false); }}
              onOpenChange={setIsCategoryOpen}
              toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                <MenuToggle ref={toggleRef} onClick={() => setIsCategoryOpen(!isCategoryOpen)} isExpanded={isCategoryOpen}>
                  {categoryLabel}
                </MenuToggle>
              )}
            >
              <SelectList>
                {CATEGORY_OPTIONS.map((o) => (
                  <SelectOption key={o.value} value={o.value}>{o.label}</SelectOption>
                ))}
              </SelectList>
            </Select>
          </FlexItem>
          <FlexItem>
            <Select
              isOpen={isRepoOpen}
              selected={repo}
              onSelect={(_e, val) => { setRepo(val as string); setOffset(0); setIsRepoOpen(false); }}
              onOpenChange={setIsRepoOpen}
              toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                <MenuToggle ref={toggleRef} onClick={() => setIsRepoOpen(!isRepoOpen)} isExpanded={isRepoOpen}>
                  {repoLabel}
                </MenuToggle>
              )}
            >
              <SelectList>
                <SelectOption value="">All Repos</SelectOption>
                {repos.map((r) => (
                  <SelectOption key={r} value={r}>{r}</SelectOption>
                ))}
              </SelectList>
            </Select>
          </FlexItem>
          <FlexItem>
            <Select
              isOpen={isTagOpen}
              selected={tag}
              onSelect={(_e, val) => { setTag(val as string); setOffset(0); setIsTagOpen(false); }}
              onOpenChange={setIsTagOpen}
              toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                <MenuToggle ref={toggleRef} onClick={() => setIsTagOpen(!isTagOpen)} isExpanded={isTagOpen}>
                  {tagLabel}
                </MenuToggle>
              )}
            >
              <SelectList>
                <SelectOption value="">All Tags</SelectOption>
                {tags.map((t) => (
                  <SelectOption key={t} value={t}>{t}</SelectOption>
                ))}
              </SelectList>
            </Select>
          </FlexItem>
        </Flex>
        <div className="card-grid">
          {memories.length === 0 && <div className="empty-state">No memories found</div>}
          {memories.map((m) => (
            <MemoryCard
              key={m.id}
              memory={m}
              selected={selected?.id === m.id}
              onClick={() => setSelected(m)}
            />
          ))}
        </div>
        <Pagination total={total} limit={LIMIT} offset={offset} onChange={setOffset} />
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
