import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Toast } from "./toast";
import { getUploadUrl, upLoadFileOSS } from "./api/upload";
import { GetUploadUrlResponse } from "@/types/upload";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const uploadFile = (
  cb: (res: Record<string, unknown>) => void,
  ccfn: (e: unknown) => void = () => {},
) => {
  const maxsize = 4 * 1024 * 1024;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,.jpeg,.png,.jpg,.gif";

  input.onchange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const img = target.files?.[0];

    if (!img) return;
    const imgName = img?.name;

    if (img.size > maxsize) {
      Toast.warning("Image size cannot exceed 4M");
      return;
    }

    const formData = new FormData();
    formData.append("file", img);
    const toastId = Toast.loading("Uploading...");
    getUploadUrl(imgName, true)
      .then((res: GetUploadUrlResponse) => {
        const publicUrl = res.publicUrl ?? "";
        upLoadFileOSS(img, res.url, res.contentType)
          .then(() => {
            cb({ toastId, publicUrl, ...res });
          })
          .catch((e: unknown) => {
            Toast.dismiss(toastId);
            ccfn(e);
          });
      })
      .catch((e: unknown) => {
        Toast.dismiss(toastId);
        ccfn(e);
      });

    input.value = "";
    input.remove();
  };

  input.click();
};
export const uploadFileAvatar = (
  cb: (res: Record<string, unknown>) => void,
  ccfn: (e: unknown) => void = () => {},
) => {
  const maxsize = 4 * 1024 * 1024;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,.jpeg,.png,.jpg,.gif";

  input.onchange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const img = target.files?.[0];

    if (!img) return;
    const imgName = img?.name;

    if (img.size > maxsize) {
      Toast.warning("Image size cannot exceed 4M");
      return;
    }

    const formData = new FormData();
    formData.append("file", img);
    const toastId = Toast.loading("Uploading...");
    getUploadUrl(imgName, true)
      .then((res: GetUploadUrlResponse) => {
        const publicUrl = res.publicUrl ?? "";
        cb({ toastId, publicUrl, ...res });
      })
      .catch((e: unknown) => {
        ccfn(e);
      })
      .finally(() => {
        Toast.dismiss(toastId);
      });

    input.value = "";
    input.remove();
  };

  input.click();
};
