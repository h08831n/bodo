export class DatabaseRequiredError extends Error {
  constructor(message = 'شناسه یا نام دیتابیس شرکت در درخواست الزامی است') {
    super(message);
    this.name = 'DatabaseRequiredError';
  }
}

export class DatabaseNotFoundError extends Error {
  constructor(message = 'دیتابیس شرکت یافت نشد یا معتبر نیست') {
    super(message);
    this.name = 'DatabaseNotFoundError';
  }
}

export class DatabaseMaintenanceError extends Error {
  public readonly retryAfterSeconds: number;
  public readonly reason?: string;

  constructor(
    db?: string,
    reason = 'دیتابیس شرکت در حال حاضر در حالت تعمیرات یا به‌روزرسانی است',
    retryAfterSeconds = 60,
  ) {
    super(
      db
        ? `دیتابیس شرکت (${db}) در حالت تعمیرات است: ${reason}`
        : `دیتابیس شرکت در حالت تعمیرات است: ${reason}`,
    );
    this.name = 'DatabaseMaintenanceError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
  }
}
