import {Requests} from "@/utils/requests";
import {pluginConfigData} from "@/index";
import {debugMessage, isEmptyValue} from "@/utils";
import {IResourceV2} from "@/types/memos/v2";
import {MemosApiServiceV2} from "@/controllers/memos/v2";
import {getBlockKramdown, putFile, sql, updateBlock} from "@/controllers/siyuan/api";
import {STORAGE_NAME} from "@/constants";



/**
 * 图床资源的类别
 */
export enum ImgbedCategory {
    image = "image",
    video = "video",
    file = "file",
    custom = "custom"
}

const IMAGE_EXTENSIONS: string[] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif", "avif", "ico", "tiff"];
const VIDEO_EXTENSIONS: string[] = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "flv", "wmv", "3gp", "ts"];


export class ImgBedService {

    /**
     * 最近一次上传失败的诊断信息
     */
    static lastError: string = '';

    /**
     * 判断资源应当上传到图床时归属的类别；返回 null 表示不参与图床分类
     * @param resource - Memos 资源
     */
    static categorize(resource: IResourceV2): ImgbedCategory | null {
        const extension = (resource.filename || "").split(".").pop()?.toLowerCase() || "";

        const customExtensions = (pluginConfigData.imgbed?.customExtensions || "")
            .split(";")
            .map(item => item.trim().toLowerCase())
            .filter(item => item.length > 0);
        if (customExtensions.length > 0 && customExtensions.includes(extension)) {
            return ImgbedCategory.custom;
        }

        const mimeType = (resource.type || "").split("/")[0];
        if (mimeType === "image" || IMAGE_EXTENSIONS.includes(extension)) {
            return ImgbedCategory.image;
        }
        if (mimeType === "video" || VIDEO_EXTENSIONS.includes(extension)) {
            return ImgbedCategory.video;
        }
        return ImgbedCategory.file;
    }

    /**
     * 资源是否应当上传至图床
     * @param resource - Memos 资源
     */
    static shouldUpload(resource: IResourceV2): boolean {
        const imgbed = pluginConfigData.imgbed;
        if (!imgbed?.enabled) {
            return false;
        }

        const selectedTypes: string[] = Array.isArray(imgbed.resourceTypes) ? imgbed.resourceTypes : [];
        if (selectedTypes.length === 0) {
            return false;
        }

        const category = this.categorize(resource);
        return category !== null && selectedTypes.includes(category);
    }

    /**
     * 上传资源到图床，成功时返回可直接引用的外链；失败返回 null（调用方回退本地落盘）
     * @param blob - 资源二进制
     * @param filename - 资源文件名
     */
    static async upload(blob: Blob, filename: string): Promise<string | null> {
        const imgbed = pluginConfigData.imgbed;
        if (!imgbed?.enabled || isEmptyText(imgbed.uploadUrl)) {
            return null;
        }

        try {
            const host = imgbed.uploadUrl.trim().replace(/\/+$/, "");
            const form = new FormData();
            form.append("file", blob, filename);

            const headerRecord: Record<string, string> = {};
            const token = (imgbed.token || "").trim();
            if (token.length > 0) {
                headerRecord["Authorization"] = `Bearer ${token}`;
            }

            const response = await Requests.upload(`${host}/upload`, blob, filename, headerRecord, true);

            if (!response.ok) {
                this.lastError = `上传响应 HTTP ${response.status}（直连与内核代理均失败）`;
                debugMessage(pluginConfigData.debug.isDebug, `图床上传失败: HTTP ${response.status}`);
                return null;
            }

            const result = await response.json();
            const src = result?.[0]?.src;
            if (isEmptyText(src)) {
                this.lastError = `图床响应异常: ${JSON.stringify(result).slice(0, 200)}`;
                debugMessage(pluginConfigData.debug.isDebug, "图床响应中缺少 src 字段", result);
                return null;
            }

            // src 形如 /file/xxxx；文档内引用使用外链地址（留空则与上传地址相同）
            const publicHost = (isEmptyText(imgbed.publicUrl) ? imgbed.uploadUrl : imgbed.publicUrl).trim().replace(/\/+$/, "");
            const link = src.startsWith("http") ? src : `${publicHost}${src}`;
            debugMessage(pluginConfigData.debug.isDebug, `图床上传成功: ${filename} -> ${link}`);
            return link;
        } catch (error: any) {
            this.lastError = String(error?.message || error);
            debugMessage(pluginConfigData.debug.isDebug, "图床上传异常，回退本地落盘", error);
            return null;
        }
    }

    /**
     * 后台上传图床：同步主流程已完成（本地落盘 + 文档写入），这里逐个上传，
     * 成功后把文档中的本地资源链接替换为图床外链。调用方不得 await。
     * @param resources - 待上传的 Memos 资源
     */
    static async uploadInBackground(resources: IResourceV2[]): Promise<void> {
        const imgbed = pluginConfigData.imgbed;
        if (!imgbed?.enabled || !resources || resources.length === 0) {
            return;
        }
        if (!imgbed.links) {
            imgbed.links = {};
        }
        let changed = false;
        for (let resource of resources) {
            try {
                // 去重：前序同步可能已上传过
                if (!isEmptyValue(imgbed.links[resource.name])) {
                    continue;
                }
                let response = await MemosApiServiceV2.downloadResource(resource);
                if (isEmptyValue(response) || !response.ok) {
                    continue;
                }
                let blob = await response.blob();
                let link = await this.upload(blob, resource.filename);
                if (isEmptyValue(link)) {
                    continue;
                }
                imgbed.links[resource.name] = link;
                changed = true;
                await this.replaceLocalLinks(resource, link);
            } catch (error) {
                debugMessage(pluginConfigData.debug.isDebug, "后台图床上传失败，保留本地链接", error);
            }
        }
        if (changed) {
            try {
                let cfgJson = JSON.stringify(pluginConfigData);
                await putFile(`/data/storage/petal/plugin-memos-sync-helper/${STORAGE_NAME}`, false, new Blob([cfgJson], {type: "application/json"}));
            } catch (error) {
                debugMessage(pluginConfigData.debug.isDebug, "后台图床链接映射持久化失败", error);
            }
        }
    }

    /**
     * 把引用了该资源本地路径的块替换为图床外链
     */
    private static async replaceLocalLinks(resource: IResourceV2, link: string): Promise<void> {
        // 本地落盘路径形如 assets/memos/<memoId>/<filename>，SQL 按文件名模糊匹配
        let safeName = (resource.filename || "").replace(/'/g, "''");
        if (isEmptyText(safeName)) {
            return;
        }
        let rows: Array<{id: string}> = [];
        try {
            rows = await sql(`SELECT id FROM blocks WHERE markdown LIKE '%${safeName}%' AND type IN ('p', 'i', 'v', 'a')`);
        } catch (error) {
            debugMessage(pluginConfigData.debug.isDebug, "后台图床链接替换：SQL 查询失败", error);
            return;
        }
        if (isEmptyValue(rows) || rows.length === 0) {
            return;
        }
        for (let row of rows) {
            try {
                let kramdown = await getBlockKramdown(row.id);
                let md = kramdown?.kramdown ?? "";
                if (md.indexOf(safeName) < 0) {
                    continue;
                }
                // 只替换本地 assets 路径，保留已是外链的部分不动
                let updated = md.replace(/\(assets\/[^)]*\/([^)]*)\)/g, (match, tail) => {
                    return tail === resource.filename ? `(${link})` : match;
                });
                if (updated !== md) {
                    await updateBlock("markdown", updated, row.id);
                    debugMessage(pluginConfigData.debug.isDebug, `后台图床链接已替换: ${resource.filename} -> ${link}`);
                }
            } catch (error) {
                debugMessage(pluginConfigData.debug.isDebug, "后台图床链接替换失败", error);
            }
        }
    }
}


function isEmptyText(value: any): boolean {
    return value === null || value === undefined || String(value).trim().length === 0;
}
