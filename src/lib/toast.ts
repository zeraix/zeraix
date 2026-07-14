import { toast, ExternalToast } from "sonner";

export const Toast = {
  success(message: string, description?: string, options?: ExternalToast) {
    return toast.success(message, {
      description,
      ...options,
    });
  },

  error(message: string, description?: string, options?: ExternalToast) {
    return toast.error(message, {
      description,
      ...options,
    });
  },

  info(message: string, description?: string, options?: ExternalToast) {
    return toast(message, {
      description,
      ...options,
    });
  },
  warning(message: string, description?: string, options?: ExternalToast){
    return toast.warning(message, {
      description,
      ...options,
    });
  },

  loading(message: string) {
    return toast.loading(message);
  },

  dismiss(id?: string | number) {
    toast.dismiss(id);
  },

  promise<T>(
    promise: Promise<T>,
    messages: {
      loading: string;
      success: string;
      error: string;
    }
  ) {
    return toast.promise(promise, messages);
  },
};