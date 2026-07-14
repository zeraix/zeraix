export interface ApiResponse<T, P = undefined> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
  pagination?: P;
}
export interface PaginationType {
  page: number;
  limit: number;
  hasMore: boolean;
}