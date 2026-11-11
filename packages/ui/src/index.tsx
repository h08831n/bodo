import React from 'react';

export interface SamplePlaceholderProps {
  label: string;
  onClick?: () => void;
}

export const SamplePlaceholder: React.FC<SamplePlaceholderProps> = ({ label, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
    >
      {label}
    </button>
  );
};
