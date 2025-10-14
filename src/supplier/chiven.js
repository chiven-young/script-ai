import axios from 'axios';
import { renderChat } from '../utils/compose';

export default class Chiven {
    static apiUrl = 'https://data.chiven.net/micro-service/pro/api/ai';
    static token = null;
    static request = null;
    static init({
        apiUrl = null,
        token = null,
        timeout = 60000,
    }) {
        this.apiUrl = apiUrl || this.apiUrl;
        this.token = token;
        this.request = axios.create({
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': this.token,
            }
        })
        // 添加响应拦截器
        this.request.interceptors.response.use(
            (response) => {
                return response.data;
            },
            (error) => {
                // 处理响应错误
                console.error('请求出错:', error);
                return Promise.reject(error);
            }
        );
    }
    static setToken(token) {
        this.token = token;
        this.request.defaults.headers['Authorization'] = token;
    }

    static async getModels() {
        const res = await this.request.get(`${this.apiUrl}/tags`);
        return res?.data?.models || [];
    }
    static async chat(params) {
        const url = `${Chiven.apiUrl}/chat`;
        const requestData = {
            key: params?.key,
            model: params?.model,
            messages: params?.messages || [],
            stream: params?.stream ? true : false,
            temperature: 1,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': Chiven.token,
                },
                body: JSON.stringify(requestData),
                signal: params?.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const contentType = response.headers.get('content-type') || '';
            // 如果是 JSON 格式，直接解析并返回
            if (contentType.includes('application/json')) {
                const data = await response.json();
                return { done: true, message: data }; // 兼容流式处理的返回格式
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
            console.error('Error in chiven chat API:', error);
            throw error;
        }
    }

    static async renderChat({
        model = 'qwq-plus',
        messages = [],
        thinkOutputId = '',
        contentOutputId = '',
        containerSelector = null,
        scroll = true,
        signal = null,
        event = (msg) => { }
    } = {}, callback) {
        renderChat({
            model, messages, thinkOutputId, contentOutputId, containerSelector, scroll, signal, event
        }, callback, this.chat)
    }

    static async generate(params, onChunkReceived) {
        try {
            if (!params || !params.model || !params.prompt) {
                throw new Error('params 对象必须包含 model 和 prompt 属性');
            }
            const url = `${Chiven.apiUrl}/chat`;
            const data = {
                model: params.model,
                messages: [
                    { role: 'user', content: params.prompt }
                ],
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
                    'Content-Type': 'application/json',
                    'Authorization': Chiven.token,
                },
                body: JSON.stringify(data),
                signal: params?.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (params.stream) {
                // 流式处理
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(line => line.trim() !== '');

                        lines.forEach(line => {
                            try {
                                const parsed = JSON.parse(line);
                                if (parsed) {
                                    onChunkReceived?.(parsed);
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
                if (result) {
                    onChunkReceived?.(result);
                }
            }

            return true; // 表示操作成功完成
        } catch (error) {
            console.error('请求出错:', error);
            onChunkReceived?.(error);
            return false; // 表示操作失败
        }
    }

    // 图片合成
    static async imageSynthesis({
        key = null,
        model = 'wanx2.1-t2i-turbo',
        input = {
            prompt: '',
            negative_prompt: '',
        },
        parameters = {
            size: '1024*1024',
            n: 4,
            prompt_extend: true,
            watermark: false,
            seed: 42
        },
        delay = 5000,
        signal = null,
        event = (msg) => { }
    } = {}, callback) {
        try {
            // 第一步：创建生成任务
            const createRes = await this.request.post(`${this.apiUrl}/image-synthesis/image-generation`, {
                key, model, input, parameters, signal
            });

            if (!createRes?.success || !createRes?.data?.output?.task_id) {
                event?.('ERROR', createRes?.message || '创建任务失败');
                return callback?.(createRes);
            }

            const task_id = createRes.data.output.task_id;
            event?.('TASK_START', task_id);

            // 轮询配置
            const maxRetries = 20; // 最大尝试次数
            const delayTime = delay; // 轮询间隔（毫秒）
            let attempts = 0;
            let taskStatus = 'RUNNING';

            while (taskStatus === 'RUNNING' && attempts < maxRetries) {
                attempts++;
                try {
                    // 第二步：查询任务状态
                    const statusRes = await this.request.get(`${this.apiUrl}/image-synthesis/tasks?task_id=${task_id}`);

                    if (!statusRes?.success) {
                        event?.('ERROR', `状态查询失败: ${statusRes?.message}`);
                        return callback?.(statusRes);
                    }

                    const { output } = statusRes.data;
                    taskStatus = output?.task_status;

                    if (taskStatus === 'RUNNING') {
                        event?.('TASK_PROGRESS', { task_id, attempts });
                        await new Promise(resolve => setTimeout(resolve, delayTime));
                    } else if (taskStatus === 'SUCCEEDED') {
                        event?.('TASK_END', { task_id, output });
                        return callback?.(output);
                    } else {
                        event?.('TASK_FAILED', { task_id, error: output?.error || '生成失败' });
                        return callback?.({ error: output?.error || '生成失败' });
                    }

                } catch (error) {
                    event?.('ERROR', `查询异常: ${error.message}`);
                    return callback?.(error);
                }
            }

            // 超过最大尝试次数处理
            event?.('TASK_TIMEOUT', { task_id, attempts });
            return callback?.({ error: '任务超时，请重试' });

        } catch (error) {
            event?.('ERROR', `请求失败: ${error.message}`);
            return callback?.(error);
        }
    }
}