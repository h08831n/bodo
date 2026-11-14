import { Controller, Post, Get, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { TemplateService } from './template.service';
import { CreateTemplateDto } from './dto/create-template.dto';

@Controller('v1/templates')
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateTemplateDto) {
    return this.templateService.create(body);
  }

  @Get()
  async findAll() {
    return this.templateService.findAll();
  }
}
