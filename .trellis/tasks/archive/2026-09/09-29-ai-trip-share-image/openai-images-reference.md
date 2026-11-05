# OpenAI Images 协议调研

来源：https://developers.openai.com/api/docs/guides/image-generation
读取日期：2026-09-29
命令：smart-search fetch https://developers.openai.com/api/docs/guides/image-generation --format markdown

官方文档提供 Images API 的 POST /v1/images/generations、Bearer 鉴权、model/prompt 参数以及 data[0].b64_json 返回示例。图像可用竖版1024x1536；服务商兼容性不能由官方文档替其保证。

本任务用户指定第三方地址 https://xjbh.lol/v1、模型 gpt-image2.5；没有第三方接口文档，按默认Images API集成并原样保留模型标识。响应另兼容 data[0].url，服务端安全下载为raster data URL。

未调用真实付费生图；真实模型可用性和尺寸支持需要用户配置独立IMAGE_API_KEY后联调。单元/API/浏览器测试均为模拟上游，不把测试占位图称为AI生成结果。
