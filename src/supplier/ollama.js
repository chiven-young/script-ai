import axios from 'axios';
import marked from '../utils/markdown';

export default class Ollama {
    static apiUrl = 'http://localhost:11434/api';

    static async getModels() {
        const res = await axios.get(`${this.apiUrl}/tags`);
        return res?.data?.models || [];
    }
    static async chat(model, messages) {
        const url = `${this.apiUrl}/chat`;
        const requestData = {
            model: model,
            messages: messages,
            stream: true,
            temperature: 1,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestData)
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
        model = 'deepseek-r1:1.5b',
        messages = [],
        thinkOutputId = 'think-output',
        contentOutputId = 'content-output',
        containerSelector = null,
        scroll = true,
        event = (msg) => { }
    } = {}, callback) {
        // 状态管理
        const state = {
            isInThink: false,
            fullText: '',
            thinkSoFar: '',
            contentSoFar: '',
            hasStartedContent: false,
        };

        // DOM 元素获取与验证
        const elements = {
            thinkOutput: document.getElementById(thinkOutputId),
            contentOutput: document.getElementById(contentOutputId)
        };

        if (!elements.contentOutput) {
            throw new Error('无法找到输出元素');
        }

        // 获取滚动容器
        const scrollContainer = containerSelector
            ? document.querySelector(containerSelector)
            : elements.contentOutput.parentElement;

        // 滚动到底部的函数
        const scrollToBottom = () => {
            if (!scroll) return;
            if (scrollContainer) {
                // 使用 requestAnimationFrame 确保在 DOM 更新后执行滚动
                requestAnimationFrame(() => {
                    const scrollOptions = {
                        top: scrollContainer.scrollHeight,
                        behavior: 'smooth'
                    };
                    scrollContainer.scrollTo(scrollOptions);
                });
            }
        };

        // 处理思考内容
        const renderThink = (thinkText) => {
            if (!elements.thinkOutput) return
            const html = marked.parse(thinkText);
            elements.thinkOutput.innerHTML = html;
            scrollToBottom();
        };

        // 处理主要内容
        const renderContent = (content) => {
            const html = marked.parse(content);
            elements.contentOutput.innerHTML = html;
            document.querySelectorAll('pre code').forEach(block => {
                hljs.highlightElement(block);
            });
            scrollToBottom();
        };

        // 处理数据块
        const processChunk = (chunk) => {
            let index = 0;
            while (index < chunk.length) {
                if (state.isInThink) {
                    const endIndex = chunk.indexOf('</think>', index);
                    if (endIndex !== -1) {
                        state.thinkSoFar += chunk.slice(index, endIndex);
                        renderThink(state.thinkSoFar);
                        state.isInThink = false;
                        event?.('THINKEND');
                        index = endIndex + 8;
                    } else {
                        state.thinkSoFar += chunk.slice(index);
                        renderThink(state.thinkSoFar);
                        break;
                    }
                } else {
                    const startIndex = chunk.indexOf('<think>', index);
                    if (startIndex !== -1) {
                        if (startIndex > index) {
                            if (!state.hasStartedContent) {
                                event?.('CONTENTSTART');
                                state.hasStartedContent = true;
                            }
                            state.contentSoFar += chunk.slice(index, startIndex);
                            renderContent(state.contentSoFar);
                        }
                        state.isInThink = true;
                        event?.('THINKSTART');
                        index = startIndex + 7;
                    } else {
                        if (!state.hasStartedContent) {
                            event?.('CONTENTSTART');
                            state.hasStartedContent = true;
                        }
                        state.contentSoFar += chunk.slice(index);
                        renderContent(state.contentSoFar);
                        break;
                    }
                }
            }
        };

        try {
            event?.('START');
            const stream = await this.chat(model, messages);
            const reader = stream.getReader();

            while (true) {
                const { done, value } = await reader.read();
                // console.log('value', done, value)
                if (done || value?.done) {
                    if (state.hasStartedContent) {
                        event?.('CONTENTEND');
                    }
                    event?.('END');
                    let endData = value;
                    endData.message.content = state.contentSoFar;
                    endData.message.fullText = state.fullText;
                    endData.message.think = state.thinkSoFar;
                    callback(endData);
                    break;
                }
                const chunk = value?.message?.content || '';
                state.fullText += chunk;
                processChunk(chunk);
            }
        } catch (error) {
            console.error('渲染聊天内容时出错:', error);
            throw error;
        }
    }

    static async generate(params) {
        const res = await axios.post(`${this.apiUrl}/generate`, params)
        return res;
    }

    static async generateText(params, onChunkReceived) {
        try {
            const url = `${this.apiUrl}/generate`;
            const data = {
                model: params?.model,
                prompt: params?.prompt,
                stream: params.stream ? true : false
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

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                lines.forEach(line => {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.response) {
                            onChunkReceived(parsed.response);
                        }
                    } catch (error) {
                        console.error('解析 JSON 时出错:', error);
                    }
                });
            }
        } catch (error) {
            console.error('请求出错:', error);
        }
    };
}