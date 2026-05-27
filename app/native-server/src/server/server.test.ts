import { describe, expect, test, afterAll, beforeAll } from '@jest/globals';
import supertest from 'supertest';
import Server from './index';

const initializeRequest = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'moyai-server-test',
      version: '1.0.0',
    },
  },
});

const mcpHeaders = {
  Accept: 'application/json, text/event-stream',
};

describe('服务器测试', () => {
  // 启动服务器测试实例
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // 关闭服务器
  afterAll(async () => {
    await Server.stop();
  });

  test('GET /ping 应返回正确响应', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
    });
  });

  test('GET /health/mcp 应返回当前 MCP session 状态', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/health/mcp')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      activeSessions: 0,
      sessions: [],
    });
  });

  test('POST /mcp 初始化后删除再初始化，不应复用已连接的 MCP server transport', async () => {
    const firstInit = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set(mcpHeaders)
      .send(initializeRequest(1))
      .expect(200);

    const firstSessionId = firstInit.headers['mcp-session-id'];
    expect(firstSessionId).toBeTruthy();

    const activeHealth = await supertest(Server.getInstance().server)
      .get('/health/mcp')
      .expect(200);
    expect(activeHealth.body.activeSessions).toBe(1);
    expect(activeHealth.body.sessions).toContain(firstSessionId);

    const deleteResponse = await supertest(Server.getInstance().server)
      .delete('/mcp')
      .set(mcpHeaders)
      .set('mcp-session-id', firstSessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'notifications/cancelled',
        params: {},
      });

    expect([200, 204]).toContain(deleteResponse.status);

    const inactiveHealth = await supertest(Server.getInstance().server)
      .get('/health/mcp')
      .expect(200);
    expect(inactiveHealth.body.activeSessions).toBe(0);
    expect(inactiveHealth.body.sessions).toEqual([]);

    const secondInit = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set(mcpHeaders)
      .send(initializeRequest(3))
      .expect(200);

    const secondSessionId = secondInit.headers['mcp-session-id'];
    expect(secondSessionId).toBeTruthy();
    expect(secondSessionId).not.toBe(firstSessionId);
  });

  test('GET /mcp 缺少 session 时应返回 JSON-RPC 错误', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/mcp')
      .expect(400)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: 'Invalid or missing MCP session ID for SSE.',
        data: {},
      },
    });
  });

  test('DELETE /mcp 缺少 session 时应返回 JSON-RPC 错误', async () => {
    const response = await supertest(Server.getInstance().server)
      .delete('/mcp')
      .expect(400)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: 'Invalid or missing MCP session ID.',
        data: {},
      },
    });
  });
});
