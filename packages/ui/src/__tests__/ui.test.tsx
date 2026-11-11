import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SamplePlaceholder } from '../index.js';

describe('UI SamplePlaceholder Component', () => {
  it('renders with given label', () => {
    render(<SamplePlaceholder label="دکمه نمونه" />);
    expect(screen.getByText('دکمه نمونه')).toBeDefined();
  });
});
