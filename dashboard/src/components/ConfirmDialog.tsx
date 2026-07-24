import { useState } from 'react';
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Content,
  TextInput
} from '@patternfly/react-core';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  inputLabel?: string;
  inputPlaceholder?: string;
  onConfirm: (inputValue?: string) => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  inputLabel,
  inputPlaceholder,
  onConfirm,
  onCancel,
}: Props) {
  const [inputValue, setInputValue] = useState('');

  const handleConfirm = () => {
    onConfirm(inputLabel ? inputValue : undefined);
    setInputValue('');
  };

  const handleCancel = () => {
    setInputValue('');
    onCancel();
  };

  return (
    <Modal
      variant={ModalVariant.small}
      isOpen={open}
      onClose={handleCancel}
      aria-label={title}
    >
      <ModalHeader title={title} />
      <ModalBody>
        <Content component="p">{message}</Content>
        {inputLabel && (
          <div style={{ marginTop: '16px' }}>
            <TextInput
              value={inputValue}
              onChange={(_e, val) => setInputValue(val)}
              aria-label={inputLabel}
              placeholder={inputPlaceholder}
              autoFocus
            />
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          variant={variant === 'danger' ? 'danger' : 'primary'}
          onClick={handleConfirm}
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" onClick={handleCancel}>
          {cancelLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
