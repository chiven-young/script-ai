import Ollama from "./supplier/ollama";
import Chiven from './supplier/chiven';

export default class scriptAI {
    static ollama = Ollama;
    static chiven = Chiven;
};