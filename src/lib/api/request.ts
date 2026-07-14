import { getAuthToken, setAuthCookie, clearAuthCookie } from '../actions/auth.actions';
import { clientEnv } from '../env';

/**
 * Generic request function (client-side version, compatible with pure static export).
 *
 * - Token is read from localStorage (does not rely on an httpOnly cookie)
 * - On 401, automatically refreshes the token and retries; if the refresh fails, redirects to the login page
 * - API address is read from NEXT_PUBLIC_API_BASE_URL
 */
function updateTokenFromResponse(response: Response): void {
  const renewedToken = response.headers.get('x-renewed-token');
  if (renewedToken) {
    // console.log('detected x-renewed-token, updating local token');
    setAuthCookie(renewedToken);
  }
}

export default async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  // skipAuthRetry: for auth endpoints such as login. A 401 from these endpoints means "wrong account/password/verification code",
  // not "session expired", and should not trigger a token refresh + redirect to the login page (which would cause a full-page form reload).
  // When set to true, a 401 returns the response body directly for the caller to display the error message.
  { skipAuthRetry = false }: { skipAuthRetry?: boolean } = {}
): Promise<T> {
  const token = getAuthToken();
  // Use the zod-validated clientEnv (with defaults): even without a configured .env it won't degrade to a relative path,
  // which after Electron packaging would resolve to the app:// protocol rather than the real backend.
  const apiBaseUrl = clientEnv.NEXT_PUBLIC_API_BASE_URL;

  // Determine whether this is FormData; FormData does not need Content-Type set (the browser sets it automatically)
  const isFormData = options.body instanceof FormData;

  const config: RequestInit = {
    credentials: 'include', // allow sending cookies
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      'Accept': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...options.headers,
    },
    ...options,
  };

  const url = `${apiBaseUrl}${endpoint}`;

  try {
    const response = await fetch(url, config);
    updateTokenFromResponse(response);

    const responseText = await response.text();

    let data: T;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.warn('JSON parse failed:', parseError);
      return Promise.reject(`Invalid JSON response: ${responseText}`);
    }

    // console.log('API response status:', response.status, data);

    // Handle 401 auth expiry: try to refresh the token and retry
    // Login endpoints (skipAuthRetry) skip this logic and return the error response body directly for the form to display
    if (response.status === 401 && !skipAuthRetry) {

      const currentToken = getAuthToken() || "";
      // if (!currentToken) {
      //   window.location.href = '/login';
      //   return Promise.reject('not logged in');
      // }

      try {
        const refreshResponse = await fetch(`${apiBaseUrl}/auth/refresh-me`, {
          method: 'POST',
          credentials: 'include', // allow sending cookies
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken}`,
          },
          body: JSON.stringify({ token: currentToken }),
        });

        const refreshData = await refreshResponse.json();

        if (refreshData.success && refreshData.data?.token) {
          const newToken: string = refreshData.data.token;
          setAuthCookie(newToken);
          // console.log('token refreshed successfully, retrying the original request');

          const retryResponse = await fetch(url, {
            ...config,
            credentials: 'include', // allow sending cookies
            headers: {
              ...(config.headers as Record<string, string>),
              'Authorization': `Bearer ${newToken}`,
            },
          });
          updateTokenFromResponse(retryResponse);
          const retryText = await retryResponse.text();
          return JSON.parse(retryText) as T;
        }
      } catch (refreshError) {
        clearAuthCookie();
        console.warn('token refresh request error:', refreshError);
      }

      // Session expired: clear it so the user falls back to guest mode. There is
      // no login page to redirect to — login is prompted on demand via the modal.
      clearAuthCookie();
      return Promise.reject('Login has expired');
    }

    return data;
  } catch (error: any) {
    return Promise.reject(`Network connection failed: ${error.message}`);
  }
}

