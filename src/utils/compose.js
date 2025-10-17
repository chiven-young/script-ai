import { markdownParse } from './markdown';

export const renderChat = async ({
    model = '',
    baseUrl = '',
    messages = [],
    thinkOutputId = '',
    contentOutputId = '',
    containerSelector = null,
    scroll = true,
    signal = null,
    event = (msg) => { },
} = {}, callback, chat) => {
    const state = {
        isInThink: false,
        thinkStartTime: 0,
        thinkEndTime: 0,
        fullText: '',
        thinkSoFar: '',
        contentSoFar: '',
        currentSliceSoFar: '',
        contents: [],
        inMeme: false,
        memeContent: '',
        currentSliceType: null,
        remainingChunk: ''
    };

    const elements = {
        thinkOutput: document.getElementById(thinkOutputId),
        contentOutput: document.getElementById(contentOutputId)
    };

    const scrollContainer = containerSelector
        ? document.querySelector(containerSelector)
        : elements.contentOutput?.parentElement;

    const scrollToBottom = () => {
        if (!scroll) return;
        if (scrollContainer) {
            requestAnimationFrame(() => {
                const scrollOptions = {
                    top: scrollContainer.scrollHeight,
                    behavior: 'smooth'
                };
                scrollContainer.scrollTo(scrollOptions);
            });
        }
    };

    const renderThink = (thinkText) => {
        if (!elements.thinkOutput) {
            elements.thinkOutput = document.getElementById(thinkOutputId);
        }
        if (!elements.thinkOutput) return;
        const html = markdownParse(thinkText);
        elements.thinkOutput.innerHTML = html;
        scrollToBottom();
    };

    const renderContent = (content) => {
        if (!elements.contentOutput) {
            elements.contentOutput = document.getElementById(contentOutputId);
        }
        if (!elements.contentOutput) return;
        const html = markdownParse(content);
        elements.contentOutput.innerHTML = html;
        scrollToBottom();
    };

    const isWhitespace = (char) => /\s/.test(char);

    const processChunk = (currentChunk) => {
        if (isEmoji(currentChunk)) {
            event?.('EMOJI', { emoji: currentChunk });
        }
        let chunk = state.remainingChunk + currentChunk;
        state.remainingChunk = '';

        let index = 0;
        while (index < chunk.length) {
            if (state.isInThink) {
                const endIndex = chunk.indexOf('</think>', index);
                if (endIndex !== -1) {
                    const thinkContent = chunk.slice(index, endIndex);
                    state.thinkSoFar = state.thinkSoFar.slice(0, -state.currentSliceSoFar.length) + thinkContent;
                    state.currentSliceSoFar = thinkContent;
                    renderThink(state.thinkSoFar);
                    state.isInThink = false;
                    state.contents.push({ type: 'think', content: state.currentSliceSoFar });
                    state.currentSliceSoFar = '';
                    state.thinkEndTime = Date.now();
                    event?.('THINK_END', { think: state.thinkSoFar, thinkEndTime: state.thinkEndTime, thinkTimeSpent: state.thinkEndTime - state.thinkStartTime });
                    state.currentSliceType = null;
                    index = endIndex + 8;
                    // 跳过空白字符（包括换行符）
                    while (index < chunk.length && isWhitespace(chunk[index])) {
                        index++;
                    }
                    // 检查下一个字符
                    if (index < chunk.length) {
                        if (chunk[index] === '♦') {
                            state.inMeme = true;
                            state.memeContent = '';
                            event?.('MEME_START', { meme: state.memeContent });
                            state.currentSliceType = 'meme';
                        } else {
                            event?.('CONTENT_START', { content: '' });
                            state.currentSliceType = 'content';
                        }
                    }
                } else {
                    const currentThinkPart = chunk.slice(index);
                    state.thinkSoFar = state.thinkSoFar.slice(0, -state.currentSliceSoFar.length) + currentThinkPart;
                    state.currentSliceSoFar = currentThinkPart;
                    renderThink(state.thinkSoFar);
                    state.remainingChunk = currentThinkPart;
                    break;
                }
            } else {
                const startIndex = chunk.indexOf('<think>', index);
                if (startIndex !== -1) {
                    if (startIndex > index) {
                        if (state.currentSliceType === 'content') {
                            state.contents.push({ type: 'content', content: state.currentSliceSoFar });
                            event?.('CONTENT_END', { content: state.currentSliceSoFar });
                            state.currentSliceSoFar = '';
                        }
                        state.contentSoFar += chunk.slice(index, startIndex);
                        state.currentSliceSoFar += chunk.slice(index, startIndex);
                        renderContent(state.contentSoFar);
                    }
                    if (state.currentSliceSoFar) {
                        state.contents.push({ type: 'content', content: state.currentSliceSoFar });
                        state.currentSliceSoFar = '';
                    }
                    state.isInThink = true;
                    state.thinkStartTime = Date.now();
                    event?.('THINK_START', { think: '', thinkStartTime: state.thinkStartTime });
                    state.currentSliceType = 'think';
                    state.currentSliceSoFar = '';
                    index = startIndex + 7;
                } else {
                    let charIndex = index;
                    while (charIndex < chunk.length) {
                        const char = chunk[charIndex];
                        if (char === '¶') {
                            if (state.currentSliceType === 'content') {
                                state.contents.push({ type: 'content', content: state.currentSliceSoFar });
                                event?.('CONTENT_END', { content: state.currentSliceSoFar });
                                state.currentSliceSoFar = '';
                            }
                            event?.('CUT');
                            state.currentSliceType = null;
                            charIndex++;
                            // 跳过空白字符（包括换行符）
                            while (charIndex < chunk.length && isWhitespace(chunk[charIndex])) {
                                charIndex++;
                            }
                            // 检查下一个字符
                            if (charIndex < chunk.length) {
                                if (chunk[charIndex] === '♦') {
                                    state.inMeme = true;
                                    state.memeContent = '';
                                    event?.('MEME_START', { meme: state.memeContent });
                                    state.currentSliceType = 'meme';
                                } else {
                                    event?.('CONTENT_START', { content: '' });
                                    state.currentSliceType = 'content';
                                }
                            }
                        } else if (char === '♦') {
                            if (state.inMeme) {
                                state.contents.push({ type: 'meme', content: state.memeContent });
                                event?.('MEME_END', { meme: state.memeContent });
                                state.memeContent = '';
                                state.inMeme = false;
                                state.currentSliceType = null;
                                charIndex++;
                                // 跳过空白字符（包括换行符）
                                while (charIndex < chunk.length && isWhitespace(chunk[charIndex])) {
                                    charIndex++;
                                }
                                // 检查下一个字符
                                if (charIndex < chunk.length) {
                                    if (chunk[charIndex] === '♦') {
                                        state.inMeme = true;
                                        state.memeContent = '';
                                        event?.('MEME_START', { meme: state.memeContent });
                                        state.currentSliceType = 'meme';
                                    } else {
                                        event?.('CONTENT_START', { content: '' });
                                        state.currentSliceType = 'content';
                                    }
                                }
                            } else {
                                if (state.currentSliceType === 'content') {
                                    state.contents.push({ type: 'content', content: state.currentSliceSoFar });
                                    event?.('CONTENT_END', { content: state.currentSliceSoFar });
                                    state.currentSliceSoFar = '';
                                }
                                state.inMeme = true;
                                state.memeContent = '';
                                event?.('MEME_START', { meme: state.memeContent });
                                state.currentSliceType = 'meme';
                                charIndex++;
                            }
                        } else {
                            if (state.inMeme) {
                                state.memeContent += char;
                            } else {
                                // 检查前面是否都是空白字符（包括换行符）
                                let prevIndex = charIndex - 1;
                                while (prevIndex >= index && isWhitespace(chunk[prevIndex])) {
                                    prevIndex--;
                                }
                                if (prevIndex < index) {
                                    // 如果前面都是空白字符，则不触发CONTENT_START
                                    state.contentSoFar += char;
                                    state.currentSliceSoFar += char;
                                    renderContent(state.contentSoFar);
                                    charIndex++;
                                    continue;
                                }
                                if (!state.currentSliceType) {
                                    event?.('CONTENT_START', { content: '' });
                                    state.currentSliceType = 'content';
                                }
                                state.contentSoFar += char;
                                state.currentSliceSoFar += char;
                                renderContent(state.contentSoFar);
                            }
                        }
                        charIndex++;
                    }
                    index = charIndex;
                }
            }
        }
        let thinkTimeSpent = 0;
        if (state.thinkStartTime) {
            if (state.thinkEndTime) {
                thinkTimeSpent = state.thinkEndTime - state.thinkStartTime;
            } else {
                const now = Date.now();
                thinkTimeSpent = now - state.thinkStartTime;
            }
        }
        event?.('OUTPUT', {
            think: state.thinkSoFar,
            content: state.contentSoFar,
            contents: state.contents,
            currentSlice: state.currentSliceSoFar,
            thinkTimeSpent: thinkTimeSpent,
            currentSliceType: state.currentSliceType,
            chunk: currentChunk
        });
    };

    try {
        event?.('START');
        const stream = await chat({ model, baseUrl, messages, signal, stream: true });
        const reader = stream.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done || value?.done) {
                if (state.currentSliceType === 'content') {
                    // 检查最后是否都是空白字符（包括换行符）
                    let endIndex = state.currentSliceSoFar.length - 1;
                    while (endIndex >= 0 && isWhitespace(state.currentSliceSoFar[endIndex])) {
                        endIndex--;
                    }
                    state.currentSliceSoFar = state.currentSliceSoFar.slice(0, endIndex + 1);
                    if (state.currentSliceSoFar) {
                        state.contents.push({ type: 'content', content: state.currentSliceSoFar });
                        event?.('CONTENT_END', { content: state.currentSliceSoFar });
                        state.currentSliceSoFar = '';
                    }
                }
                if (state.inMeme) {
                    state.contents.push({ type: 'meme', content: state.memeContent });
                    event?.('MEME_END', { meme: state.memeContent });
                    state.memeContent = '';
                    state.inMeme = false;
                }
                event?.('END');
                let endData = value && typeof value === 'object' ? value : {};
                endData.message = endData?.message && typeof endData.message === 'object' ? endData.message : {};
                endData.message.content = state.contentSoFar;
                endData.message.fullText = state.fullText;
                endData.message.think = state.thinkSoFar;
                endData.message.contents = state.contents;
                callback(endData);
                break;
            }
            const chunk = value?.message?.content || '';
            state.fullText += chunk;
            processChunk(chunk);
        }
    } catch (error) {
        console.error('渲染聊天内容时出错:', error);
        if (error.name === 'AbortError') {
            event?.('STOP', { reason: '请求被终止' });
            let endData = {
                message: {}
            };
            endData.message.content = state.contentSoFar;
            endData.message.fullText = state.fullText;
            endData.message.think = state.thinkSoFar;
            endData.message.contents = state.contents;
            callback(endData);
        } else {
            event?.('ERROR', { reason: '与AI的通信出错', code: 401 });
            throw error;
        }
    }
}

export const isEmoji = (char) => {
  if (!char) return false;
  const emojiRegex = /[\p{Emoji_Presentation}\u200d\uFE0F]/u;
  return emojiRegex.test(char);
}