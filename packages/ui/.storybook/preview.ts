import type { Preview } from '@storybook/react';

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: '^on[A-Z].*' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#ffffff' },
        { name: 'dark', value: '#0f172a' },
      ],
    },
  },
  globalTypes: {
    direction: {
      name: 'Direction',
      description: 'Direction (RTL/LTR)',
      defaultValue: 'rtl',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'rtl', title: 'RTL (راست‌چین)' },
          { value: 'ltr', title: 'LTR (چپ‌چین)' },
        ],
        showName: true,
      },
    },
    theme: {
      name: 'Theme',
      description: 'Global theme for components',
      defaultValue: 'light',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', icon: 'circlehollow', title: 'روشن (Light)' },
          { value: 'dark', icon: 'circle', title: 'تیره (Dark)' },
        ],
        showName: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const dir = context.globals.direction || 'rtl';
      const theme = context.globals.theme || 'light';
      document.documentElement.dir = dir;
      document.documentElement.lang = dir === 'rtl' ? 'fa' : 'en';
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      return Story();
    },
  ],
};

export default preview;
