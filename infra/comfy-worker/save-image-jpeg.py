"""Headless high-quality JPEG output node for agent-runtime workflows."""

import os

import folder_paths
import numpy as np
from PIL import Image


class SaveImageJPEG:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "runtime"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "api/image"

    def save(self, images, filename_prefix="runtime", quality=95):
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory(), images[0].shape[1], images[0].shape[0])
        results = []
        for img_tensor in images:
            image = Image.fromarray((img_tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8))
            output_filename = f"{filename}_{counter:05d}_.jpg"
            image.save(os.path.join(full_output_folder, output_filename), "JPEG", quality=quality, subsampling=0, optimize=True)
            results.append({"filename": output_filename, "subfolder": subfolder, "type": "output"})
            counter += 1
        return {"ui": {"images": results}}


NODE_CLASS_MAPPINGS = {"SaveImageJPEG": SaveImageJPEG}
NODE_DISPLAY_NAME_MAPPINGS = {"SaveImageJPEG": "Save Image (JPEG)"}
