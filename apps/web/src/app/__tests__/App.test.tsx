import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import App from '../App';

describe('Web App Component', () => {
  it('renders title, subtitle, and UI shared component', () => {
    render(<App />);
    expect(screen.getByText('bodo ERP')).toBeInTheDocument();
    expect(screen.getByText('سامانه یکپارچه مدیریت بازرگانی آهن‌آلات')).toBeInTheDocument();
    expect(screen.getByText('تست کامپوننت مشترک UI')).toBeInTheDocument();
  });

  it('toggles theme when dark mode button is clicked', () => {
    render(<App />);
    const themeButton = screen.getByRole('button', { name: /تغییر تم/i });
    expect(themeButton).toBeInTheDocument();

    const initialDark = document.documentElement.classList.contains('dark');
    fireEvent.click(themeButton);
    expect(document.documentElement.classList.contains('dark')).toBe(!initialDark);
  });
});
