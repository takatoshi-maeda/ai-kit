export interface GoogleLikeClientOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
}

export interface ResolvedGoogleClientOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  googleAuthOptions?: {
    credentials: {
      client_email?: string;
      private_key?: string;
    };
  };
}

export function resolveGoogleClientOptions(
  options: GoogleLikeClientOptions,
): ResolvedGoogleClientOptions {
  const apiKey = options.apiKey
    ?? process.env.GEMINI_API_KEY
    ?? process.env.GOOGLE_API_KEY;

  if (apiKey) {
    return { apiKey };
  }

  const saJson = process.env.GOOGLE_CLOUD_SA_CREDENTIAL;
  if (saJson) {
    const sa = JSON.parse(saJson) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    return {
      vertexai: true,
      project: options.project ?? sa.project_id,
      location: options.location ?? "us-central1",
      googleAuthOptions: {
        credentials: {
          client_email: sa.client_email,
          private_key: sa.private_key,
        },
      },
    };
  }

  if (options.vertexai) {
    return {
      vertexai: true,
      project: options.project,
      location: options.location ?? "us-central1",
    };
  }

  return {};
}
