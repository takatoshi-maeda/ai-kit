declare module "langfuse" {
  export class Langfuse {
    constructor(options?: {
      publicKey?: string;
      secretKey?: string;
      baseUrl?: string;
    });
    trace(params: Record<string, unknown>): {
      span(params: Record<string, unknown>): {
        update(params: Record<string, unknown>): void;
        end(): void;
      };
      generation(params: Record<string, unknown>): {
        update(params: Record<string, unknown>): void;
        end(): void;
      };
    };
  }

  export default Langfuse;
}
