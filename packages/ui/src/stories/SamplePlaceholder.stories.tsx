import type { Meta, StoryObj } from '@storybook/react';
import { SamplePlaceholder } from '../index.js';

const meta: Meta<typeof SamplePlaceholder> = {
  title: 'Sample/SamplePlaceholder',
  component: SamplePlaceholder,
  tags: ['autodocs'],
  args: {
    label: 'دکمه نمونه در محیط RTL',
  },
};

export default meta;
type Story = StoryObj<typeof SamplePlaceholder>;

export const Default: Story = {};

export const CustomLabel: Story = {
  args: {
    label: 'تایید و ادامه',
  },
};
