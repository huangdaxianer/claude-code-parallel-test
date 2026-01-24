/**
 * ingestHelpers.js 单元测试
 */

describe('ingestHelpers module', () => {
    let helpers;

    beforeAll(() => {
        helpers = require('../services/ingestHelpers');
    });

    describe('processToolUse', () => {
        test('handles Bash tool with command', () => {
            const toolObj = {
                name: 'Bash',
                id: 'tool_123',
                input: { command: 'ls -la' }
            };

            const result = helpers.processToolUse(toolObj, '{}');
            expect(result.type).toBe('Bash');
            expect(result.toolName).toBe('Bash');
            expect(result.toolUseId).toBe('tool_123');
            expect(result.previewText).toBe('ls -la');
            expect(result.typeClass).toBe('type-tool');
        });

        test('handles Read tool with file_path', () => {
            const toolObj = {
                name: 'Read',
                id: 'tool_456',
                input: { file_path: '/path/to/file.js' }
            };

            const result = helpers.processToolUse(toolObj, '{}');
            expect(result.previewText).toBe('file.js');
            expect(result.typeClass).toBe('type-success');
        });

        test('handles Task tool as SUBAGENT', () => {
            const toolObj = {
                name: 'Task',
                id: 'tool_789',
                input: { description: 'Run tests' }
            };

            const result = helpers.processToolUse(toolObj, '{}');
            expect(result.type).toBe('SUBAGENT');
            expect(result.previewText).toBe('Run tests');
        });

        test('handles TodoWrite with in_progress item', () => {
            const toolObj = {
                name: 'TodoWrite',
                id: 'tool_abc',
                input: {
                    todos: [
                        { status: 'completed', content: 'Step 1' },
                        { status: 'in_progress', content: 'Step 2' },
                        { status: 'pending', content: 'Step 3' }
                    ]
                }
            };

            const result = helpers.processToolUse(toolObj, '{}');
            expect(result.previewText).toBe('(2/3) Step 2');
        });

        test('handles TodoWrite with all completed', () => {
            const toolObj = {
                name: 'TodoWrite',
                id: 'tool_def',
                input: {
                    todos: [
                        { status: 'completed', content: 'Step 1' },
                        { status: 'completed', content: 'Step 2' }
                    ]
                }
            };

            const result = helpers.processToolUse(toolObj, '{}');
            expect(result.previewText).toBe('completed');
        });
    });

    describe('getLogEntries', () => {
        test('parses assistant text message', () => {
            const obj = {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Hello, this is a test.' }
                    ]
                }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(1);
            expect(entries[0].type).toBe('TXT');
            expect(entries[0].previewText).toBe('Hello, this is a test.');
        });

        test('parses assistant with tool_use block', () => {
            const obj = {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', name: 'Bash', id: 'test_id', input: { command: 'echo test' } }
                    ]
                }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(1);
            expect(entries[0].type).toBe('Bash');
            expect(entries[0].previewText).toBe('echo test');
        });

        test('parses direct tool_use object', () => {
            const obj = {
                type: 'tool_use',
                name: 'Write',
                id: 'write_123',
                input: { file_path: '/src/index.js' }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(1);
            expect(entries[0].type).toBe('Write');
            expect(entries[0].previewText).toBe('index.js');
        });

        test('parses error objects', () => {
            const obj = {
                type: 'error',
                error: { message: 'Something went wrong' }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(1);
            expect(entries[0].type).toBe('ERROR');
            expect(entries[0].typeClass).toBe('type-error');
            expect(entries[0].previewText).toBe('Something went wrong');
        });

        test('parses user tool_result', () => {
            const obj = {
                type: 'user',
                message: {
                    content: [
                        { type: 'tool_result', tool_use_id: 'tool_xyz', content: 'Success!' }
                    ]
                }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(1);
            expect(entries[0].type).toBe('tool_result');
            expect(entries[0].skip).toBe(true);
            expect(entries[0].toolUseId).toBe('tool_xyz');
        });

        test('ignores empty text blocks', () => {
            const obj = {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'text', text: '' },
                        { type: 'text', text: '(no content)' }
                    ]
                }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(0);
        });

        test('handles thought blocks', () => {
            const obj = {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'thought', thought: 'Let me think about this...' }
                    ]
                }
            };

            const entries = helpers.getLogEntries(obj, '{}');
            expect(entries.length).toBe(1);
            expect(entries[0].previewText).toContain('*Thought:');
        });
    });

    describe('parseStats', () => {
        const baseStats = {
            status: 'running',
            duration: 0,
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            toolCounts: {
                TodoWrite: 0,
                Read: 0,
                Write: 0,
                Bash: 0
            }
        };

        test('parses result object with completion', () => {
            const obj = {
                type: 'result',
                is_error: false,
                duration_ms: 5000,
                usage: {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_input_tokens: 20
                }
            };

            const result = helpers.parseStats(obj, baseStats);
            expect(result.status).toBe('completed');
            expect(result.duration).toBe('5.0');
            expect(result.inputTokens).toBe(100);
            expect(result.outputTokens).toBe(50);
            expect(result.cacheReadTokens).toBe(20);
        });

        test('parses result object with error', () => {
            const obj = {
                type: 'result',
                is_error: true
            };

            const result = helpers.parseStats(obj, baseStats);
            expect(result.status).toBe('stopped');
        });

        test('increments turns on user message', () => {
            const obj = { type: 'user' };
            const result = helpers.parseStats(obj, { ...baseStats, turns: 5 });
            expect(result.turns).toBe(6);
        });

        test('counts tool_use calls', () => {
            const obj = { type: 'tool_use', name: 'Bash' };
            const result = helpers.parseStats(obj, baseStats);
            expect(result.toolCounts.Bash).toBe(1);
        });

        test('counts tool_use in assistant blocks', () => {
            const obj = {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', name: 'Write' },
                        { type: 'tool_use', name: 'Read' }
                    ]
                }
            };

            const result = helpers.parseStats(obj, baseStats);
            expect(result.toolCounts.Write).toBe(1);
            expect(result.toolCounts.Read).toBe(1);
        });
    });
});
