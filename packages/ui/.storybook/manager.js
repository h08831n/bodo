import { addons } from '@storybook/manager-api';
import { create } from '@storybook/theming/create';

const theme = create({
  base: 'light',
  brandTitle: 'bodo ERP UI Components',
  fontBase: 'Vazirmatn, system-ui, -apple-system, sans-serif',
  fontCode: 'ui-monospace, SFMono-Regular, monospace',
});

addons.setConfig({
  theme,
});
