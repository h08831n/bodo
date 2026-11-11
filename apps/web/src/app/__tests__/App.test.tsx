import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import App from '../App';

describe('Web App Component', () => {
  it('renders title and greeting', () => {
    render(<App />);
    expect(screen.getByText('bodo ERP')).toBeInTheDocument();
    expect(screen.getByText('سامانه یکپارچه مدیریت بازرگانی آهن‌آلات')).toBeInTheDocument();
    expect(screen.getByText('تست کامپوننت مشترک UI')).toBeInTheDocument();
  });
});
