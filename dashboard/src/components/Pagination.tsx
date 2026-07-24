import { Pagination as PFPagination } from '@patternfly/react-core';

interface Props {
  total: number;
  limit: number;
  offset: number;
  onChange: (newOffset: number) => void;
}

export default function Pagination({ total, limit, offset, onChange }: Props) {
  if (total <= limit) return null;

  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <PFPagination
      itemCount={total}
      perPage={limit}
      page={currentPage}
      onSetPage={(_e, page) => onChange((page - 1) * limit)}
      isCompact
      style={{ marginTop: '16px' }}
    />
  );
}
