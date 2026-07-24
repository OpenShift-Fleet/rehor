import type { Memory } from '../types';
import { sourceUrl, displayKey } from '../utils';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  CardFooter,
  Label,
  LabelGroup,
  Content
} from '@patternfly/react-core';

interface Props {
  memory: Memory;
  selected?: boolean;
  showSimilarity?: boolean;
  onClick?: () => void;
}

const categoryColors: Record<string, 'green' | 'orange' | 'blue' | 'grey'> = {
  learning: 'green',
  review_feedback: 'orange',
  codebase_pattern: 'blue',
};

export default function MemoryCard({ memory, selected, showSimilarity, onClick }: Props) {
  const preview = memory.content.length > 150
    ? memory.content.slice(0, 150) + '...'
    : memory.content;

  const badgeColor = categoryColors[memory.category] || 'green';

  return (
    <Card
      isCompact
      isGlass
      isSelected={selected}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      <CardHeader>
        <CardTitle>{memory.title}</CardTitle>
      </CardHeader>
      <CardBody>
        <Content component="p" style={{ color: 'var(--pf-v6-global--Color--200)', margin: 0 }}>
          {preview}
        </Content>
      </CardBody>
      <CardFooter>
        <LabelGroup>
          <Label color={badgeColor}>{memory.category.replace(/_/g, ' ')}</Label>
          {memory.repo && <Label variant="outline">{memory.repo}</Label>}
          {displayKey(memory) && (
            <span onClick={(e) => e.stopPropagation()}>
              <Label color="blue" href={sourceUrl(memory) || '#'}>
                {displayKey(memory)}
              </Label>
            </span>
          )}
          {memory.tags.map((t) => (
            <Label key={t} variant="outline">{t}</Label>
          ))}
          {showSimilarity && memory.similarity != null && (
            <Label color="blue">{(memory.similarity * 100).toFixed(0)}%</Label>
          )}
        </LabelGroup>
      </CardFooter>
    </Card>
  );
}
