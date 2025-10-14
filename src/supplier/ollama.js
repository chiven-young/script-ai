import axios from 'axios';
import { renderChat } from '../utils/compose';

export default class Ollama {
    static apiUrl = 'http://localhost:11434';

    static async getModels(baseUrl) {
        const res = await axios.get(`${baseUrl || this.apiUrl}/api/tags`);
        return res?.data?.models || [];
    }
    static async chat(params) {
        const url = `${params?.baseUrl || Ollama.apiUrl}/api/chat`;
        const requestData = {
            model: params?.model,
            messages: params?.messages || [],
            stream: params?.stream ? true : false,
            temperature: 1,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestData),
                signal: params?.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // 处理流式响应
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            return new ReadableStream({
                async start(controller) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            break;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (line.trim() !== '') {
                                try {
                                    const chunk = JSON.parse(line);
                                    controller.enqueue(chunk);
                                } catch (error) {
                                    console.error('Error parsing JSON chunk:', error);
                                }
                            }
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Error in Ollama chat API:', error);
            throw error;
        }
    }
    // 将流式渲染封装起来
    static async renderChat({
        model = '',
        baseUrl = '',
        messages = [],
        thinkOutputId = '',
        contentOutputId = '',
        containerSelector = null,
        scroll = true,
        signal = null,
        event = (msg) => { }
    } = {}, callback) {
        renderChat({
            model, baseUrl, messages, thinkOutputId, contentOutputId, containerSelector, scroll, signal, event
        }, callback, this.chat)
    }

    static async generate(params, onChunkReceived) {
        try {
            if (!params || !params.model || !params.prompt) {
                throw new Error('params 对象必须包含 model 和 prompt 属性');
            }

            const url = `${params?.baseUrl || this.apiUrl}/api/generate`;
            const data = {
                model: params.model,
                prompt: params.prompt,
                stream: params.stream || false,
                format: params.format,
                context: params.context,
                temperature: params.temperature,
                top_k: params.top_k,
                top_p: params.top_p,
                num_predict: params.num_predict,
                stop: params.stop,
                repeat_penalty: params.repeat_penalty,
                seed: params.seed
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (params.stream) {
                // 流式处理
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(line => line.trim() !== '');

                        lines.forEach(line => {
                            try {
                                const parsed = JSON.parse(line);
                                if (parsed.response) {
                                    onChunkReceived?.(parsed.response);
                                }
                            } catch (error) {
                                console.error('解析 JSON 时出错:', error);
                            }
                        });
                    }
                } finally {
                    // 释放 reader 资源
                    reader.releaseLock();
                }
            } else {
                // 非流式处理
                const result = await response.json();
                if (result.response) {
                    onChunkReceived?.(result.response);
                }
            }

            return true; // 表示操作成功完成
        } catch (error) {
            console.error('请求出错:', error);
            onChunkReceived?.(error);
            return false; // 表示操作失败
        }
    }
}