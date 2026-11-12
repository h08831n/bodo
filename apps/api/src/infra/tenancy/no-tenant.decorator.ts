import { SetMetadata } from '@nestjs/common';

export const NO_TENANT_KEY = 'NO_TENANT_KEY';
export const NoTenant = () => SetMetadata(NO_TENANT_KEY, true);
