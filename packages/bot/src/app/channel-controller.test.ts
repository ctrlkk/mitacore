import { expect, test } from "vitest";
import { ChannelController } from "./channel-controller";

test("验证码只能提交给正在等待的登录请求", async () => {
  const controller = new ChannelController();
  expect(controller.submitVerifyCode("123456")).toBe(false);

  const pendingCode = controller.waitForVerifyCode();
  expect(controller.submitVerifyCode("123456")).toBe(true);
  await expect(pendingCode).resolves.toBe("123456");
  expect(controller.submitVerifyCode("123456")).toBe(false);
});

test("登录结果交由运行时在持久化后发布就绪状态", async () => {
  const controller = new ChannelController();
  const snapshots: string[] = [];
  controller.subscribe((snapshot) => snapshots.push(snapshot.weixin.status));

  await controller.loginWithQr(async () => {
    controller.updateWeixin({ qrcode_content: "login-payload" });
    return { accountId: "bot-id", token: "token" };
  });

  expect(controller.getSnapshot().weixin).toEqual({
    status: "waiting_qr",
    qrcode_content: "login-payload",
    error: undefined,
  });
  expect(snapshots).toEqual(["waiting_qr", "waiting_qr"]);
});
