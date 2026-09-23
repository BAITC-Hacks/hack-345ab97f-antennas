export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}
export function publicError(error) {
  return error instanceof AppError
    ? { error: error.code, message: error.message }
    : { error: "internal_error", message: "Внутренняя ошибка сервера. Проверьте локальное хранилище." };
}
