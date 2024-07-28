"use client";
import {
  ApiPath,
  DEFAULT_API_HOST,
  DEFAULT_MODELS,
  OpenaiPath,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "@/app/utils/format";
import { getClientConfig } from "@/app/config/client";
import { makeAzurePath } from "@/app/azure";
import {
  getMessageTextContent,
  getMessageImages,
  isVisionModel,
} from "@/app/utils";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

interface RequestPayload {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  stream?: boolean;
  model: string;
  temperature: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_p: number;
  max_tokens?: number;
}

export class AllenApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      const isAzure = accessStore.provider === ServiceProvider.Azure;

      if (isAzure && !accessStore.isValidAzure()) {
        throw Error(
          "incomplete azure config, please check it in your settings page",
        );
      }

      if (isAzure) {
        path = makeAzurePath(path, accessStore.azureApiVersion);
      }

      baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      baseUrl = isApp ? DEFAULT_API_HOST + "/api/proxy/allen" : ApiPath.Allen;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.OpenAI)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    console.log({
      messsage: "extractMessage",
      res,
    });
    return res.Respond;
  }

  async chat(options: ChatOptions) {
    const visionModel = isVisionModel(options.config.model);
    const messages = options.messages.map((v) => ({
      role: v.role,
      content: visionModel ? v.content : getMessageTextContent(v),
    }));
    const latestMessage = messages[messages.length - 1];
    let hasImage = false;
    if (typeof latestMessage.content === "string") {
      hasImage = false;
    } else {
      hasImage = latestMessage.content.some((v) => v?.type === "image_url");
    }
    // const hasImage = messages.some((item) => {
    //   if (typeof item.content === "string") {
    //     return false;
    //   }
    //   return item.content.some((v) => v?.type === "image_url");
    // });
    let formData;
    if (hasImage) {
      console.log({
        latestMessage,
      });
      if (typeof latestMessage.content === "string") {
        options.onError?.(new Error("Image error"));
        return;
      }
      const imageInfo = latestMessage.content.find(
        (v) => v?.type === "image_url",
      );
      if (!imageInfo) {
        options.onError?.(new Error("Image url not found"));
        return;
      }
      const base64 = imageInfo.image_url?.url;
      if (!base64) {
        options.onError?.(new Error("Image url not found"));
        return;
      }
      formData = parseBase64ToFormData(base64);
    }

    const requestPayloadForText = messages.map((item) => {
      const data: any = {};
      if (!item.role) {
        data.message = item.content;
      } else {
        data[item.role] = contentToAllenPayload(item.content);
      }
      return data;
    });

    console.log("[Request] openai payload: ", {
      messages,
      hasImage,
      requestPayloadForText,
    });

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const isImage = hasImage && formData;
      // const chatPath = "https://chat-tutor-deploy.onrender.com/upload_text/";
      // const chatPath = "https://nest-test-k66z.onrender.com/upload_text/";
      const chatPath = isImage
        ? "/api/proxy/allen/upload_image/"
        : "/api/proxy/allen/upload_text/";
      const isApp = !!getClientConfig()?.isApp;

      // const baseUrl = isApp
      //     ? DEFAULT_API_HOST +
      //       "/api/proxy/google/" +
      //       Google.ChatPath(modelConfig.model)
      //     : this.path(Google.ChatPath(modelConfig.model));

      const chatPayload = {
        method: "POST",
        body: isImage
          ? formData
          : JSON.stringify({
              conversation: requestPayloadForText,
            }),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(chatPath, chatPayload);
      clearTimeout(requestTimeoutId);

      const resJson = await res.json();
      const message = this.extractMessage(resJson);
      options.onFinish(message);
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter((m) => m.id.startsWith("gpt-"));
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      provider: {
        id: "openai",
        providerName: "OpenAI",
        providerType: "openai",
      },
    }));
  }
}
export { OpenaiPath };

function contentToAllenPayload(content: any) {
  if (content instanceof Array) {
    return content
      .filter((v) => v?.type === "text")
      .map((item) => {
        return item.text;
      })
      .join("\n");
  }
  if (typeof content === "string") {
    return content;
  }
}

// Function to convert base64 to Blob
function base64ToBlob(base64: string, contentType = "", sliceSize = 512) {
  const byteCharacters = atob(base64);
  const byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize);

    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  const blob = new Blob(byteArrays, { type: contentType });
  return blob;
}

function parseBase64ToFormData(base64Image: string) {
  // Extract the base64 string and content type
  const base64ImageParts = base64Image.split(",");
  const contentType = base64ImageParts[0].split(":")[1].split(";")[0];
  const base64String = base64ImageParts[1];

  // Convert base64 to Blob
  const imageBlob = base64ToBlob(base64String, contentType);

  // Create a FormData object and append the Blob
  const formData = new FormData();
  formData.append("file", imageBlob, "image.jpg");

  return formData;
}
