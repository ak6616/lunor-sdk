import LogVault from "./LogVault";

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface ApiResponse<T = unknown> {
  data: T;
  status: number;
}

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const { method = "GET", body, headers = {} } = options;
  const url = `${BASE_URL}${path}`;

  return LogVault.performance.measure(
    `api.${method}.${path}`,
    async () => {
      try {
        LogVault.info(`API Request: ${method} ${path}`, {
          source: "api-client",
        });

        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const data = await response.json();

        if (!response.ok) {
          const error = new Error(data.error || `HTTP ${response.status}`);

          LogVault.captureException(error, {
            type: "NETWORK",
            severity: response.status >= 500 ? "HIGH" : "MEDIUM",
            metadata: {
              url: path,
              method,
              statusCode: response.status,
              responseBody: data,
            },
          });

          throw error;
        }

        LogVault.info(`API Response: ${method} ${path} → ${response.status}`, {
          source: "api-client",
          statusCode: response.status,
        });

        return { data: data as T, status: response.status };
      } catch (error) {
        if (error instanceof TypeError && error.message.includes("fetch")) {
          // Network error
          LogVault.captureException(error, {
            type: "NETWORK",
            severity: "HIGH",
            metadata: {
              url: path,
              method,
              errorType: "network_failure",
            },
          });

          LogVault.security({
            type: "SUSPICIOUS_ACTIVITY",
            description: "API endpoint unreachable — possible network issue",
            metadata: { url: path },
          });
        }

        throw error;
      }
    },
    { url: path, method },
  );
}
